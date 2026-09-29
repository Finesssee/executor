/** Cloud's app runtime: the shared runner in the API Worker, with R2 and the Cache API as build store. */
import { CacheCommand } from "@executor-js/app-cache/contracts";
import { discardsEvaluated } from "@executor-js/app-cache/changes";
import { traceHeaders } from "@executor-js/telemetry";
import {
  AppCacheChanges,
  BuildId,
  RuntimeBuildFailed,
  BuildMemoryExceeded,
  RuntimeProtocolUnsupported,
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { appRuntime, makeAppRunner } from "@executor-js/sdk/workerd";
import {
  DatabaseFieldReserved,
  HostRequirementsError,
  DeclaredRequirements,
  HostResponse,
} from "apps/contracts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Option, Schema } from "effect";
import { CurrentOrganization, CurrentUserId } from "@executor-js/hosted-server";
import type { AppDataSupervisor } from "./app-data.ts";
import { dataChanges } from "../implementation/data-changes.ts";
import { cachedRuntimeBuilds } from "../implementation/runtime-build-cache.ts";
import type { DurableObjectNamespace, Fetcher, WorkerLoader } from "@cloudflare/workers-types";
import { CloudCompileResult } from "../contracts/builds.ts";
import { AppCompiler } from "./compiler.ts";
import { AppOutbound } from "./app-outbound.ts";
import {
  loadCloudBuild,
  retainCloudBuild,
  cloudBuildAsset,
} from "../implementation/build-storage.ts";

/** The deployer sees the underlying failure; builds bind no accounts, so it holds no credentials. */
const failed = (stage: RuntimeBuildFailed["stage"], cause: unknown) =>
  new RuntimeBuildFailed({
    stage,
    message: describeBuildCause(cause),
    ...(Schema.is(DatabaseFieldReserved)(cause) ? { declaration: cause } : {}),
  });
/**
 * Attribute Worker Loader use to the caller. Cloudflare bills each unique loaded Worker per day,
 * and its own usage data cannot be split by user or organization.
 */
const withActor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const user = Context.get(context, CurrentUserId);
    const organization = Context.getOption(context, CurrentOrganization);
    return yield* effect.pipe(
      Effect.annotateSpans({
        ...(user === undefined ? {} : { "executor.user.id": user }),
        ...(Option.isSome(organization)
          ? { "executor.organization.id": organization.value.organization }
          : {}),
      }),
    );
  });
const NativeFetcher = Schema.declare(
  (value): value is Fetcher =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);
const NativeLoader = Schema.declare(
  (value): value is Pick<WorkerLoader, "get"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function",
);
const NativeNamespace = Schema.declare(
  (value): value is Pick<DurableObjectNamespace, "getByName"> =>
    typeof value === "object" &&
    value !== null &&
    "getByName" in value &&
    typeof value.getByName === "function",
);

/** Native Alchemy bindings are resolved once; actual work belongs to the current invocation. */
export const cloudRuntime = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  origin: string,
) {
  yield* Cloudflare.WorkerLoader("AppLoader");
  const compiler = yield* Cloudflare.Workers.bindWorker(AppCompiler);
  const network = yield* AppOutbound;
  const worker = yield* Cloudflare.Worker;
  yield* worker.bind`${network}`({
    bindings: [{ type: "service", name: "AppOutbound", service: network.workerName }],
  });
  const environment = yield* Cloudflare.WorkerEnvironment;
  return Effect.gen(function* () {
    // This runtime is memoized in whichever scope first uses it; an MCP execution scopes each
    // operation. A successful call's cache refreshes belong to the Worker or Durable Object
    // invocation, as self-host's waitUntil and local's runtime-owned refreshes do, so they never
    // hold an operation, its database client or its result open.
    const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
    const runner = makeAppRunner({
      loader: yield* Schema.decodeUnknownEffect(NativeLoader)(environment.AppLoader).pipe(
        Effect.orDie,
      ),
      // Always the private service, which enforces public routing. The strictly-public
      // compatibility flag would bypass it.
      outbound: yield* Schema.decodeUnknownEffect(NativeFetcher)(environment.AppOutbound).pipe(
        Effect.orDie,
      ),
      data: (app) => {
        const target = databases.getByName(app);
        return {
          invoke: (input, load, elicit, controls) =>
            target
              .invoke(input, load, elicit, controls)
              .pipe(Effect.provide(RuntimeContext.phantom)),
          cancel: (id) => target.cancel(id).pipe(Effect.provide(RuntimeContext.phantom)),
          cache: (namespace, command) =>
            Effect.gen(function* () {
              const parsed = yield* Schema.decodeUnknownEffect(CacheCommand)(command);
              yield* Effect.annotateCurrentSpan("cache.operation", parsed.operation);
              const reply = yield* target.cache(namespace, parsed);
              // Cache commands can arrive after the invocation, from a background refresh.
              if (discardsEvaluated(parsed)) yield* (yield* AppCacheChanges).changed(app);
              return reply;
            }).pipe(Effect.provide(RuntimeContext.phantom), Effect.withSpan("runtime.cloud.cache")),
        };
      },
      waitUntil,
    });
    const load = yield* cachedRuntimeBuilds(origin, (build) =>
      loadCloudBuild(build).pipe(Effect.provide(RuntimeContext.phantom)),
    );
    const runtime = yield* appRuntime({
      name: "runtime.cloud",
      loadBuild: (build) =>
        load(build).pipe(
          Effect.map(({ mainModule, modules, protocol }) => ({ mainModule, modules, protocol })),
        ),
      invoke: (invocation, capabilities) => withActor(runner.invoke(invocation, capabilities)),
      build: ({ files }) =>
        withActor(
          Effect.gen(function* () {
            const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
            const result = yield* compiler.compile(files, headers).pipe(
              Effect.catchTag("RpcCallError", (error) => {
                const cause = error.cause;
                return Effect.fail(
                  cause instanceof Error && /^Worker exceeded memory limit\.?$/.test(cause.message)
                    ? new BuildMemoryExceeded()
                    : failed("compile", cause instanceof Error ? cause : error),
                );
              }),
              Effect.flatMap(Schema.decodeUnknownEffect(CloudCompileResult)),
              Effect.catchTag("SchemaError", (cause) => Effect.fail(failed("compile", cause))),
              Effect.withSpan("runtime.cloud.compiler.request"),
            );
            if (!result.ok) return yield* Effect.fail(result.error);
            const { bundle, ui, protocol } = result.value;
            const build = BuildId.make(`bld_${crypto.randomUUID()}`);
            const requirements = yield* runner.declare({ ...bundle, protocol }, headers).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
              Effect.flatMap((envelope) =>
                envelope.ok
                  ? Schema.decodeUnknownEffect(DeclaredRequirements)(envelope.value)
                  : Schema.decodeUnknownEffect(HostRequirementsError)(envelope.error).pipe(
                      Effect.flatMap(Effect.fail),
                    ),
              ),
              Effect.mapError((cause) => failed("declaration", cause)),
              Effect.withSpan("runtime.cloud.requirements"),
            );
            const assets = yield* retainCloudBuild(
              build,
              {
                ...bundle,
                database: requirements.database !== undefined,
                protocol,
              },
              ui,
            ).pipe(Effect.provide(RuntimeContext.phantom));
            return { build, requirements, ...(assets === undefined ? {} : { ui: assets }) };
          }).pipe(
            Effect.tapError((error) =>
              Effect.annotateCurrentSpan({
                "build.stage": Schema.is(BuildMemoryExceeded)(error)
                  ? "compile"
                  : Schema.is(RuntimeProtocolUnsupported)(error)
                    ? "protocol"
                    : Schema.is(RuntimeAppsDependencyMissing)(error)
                      ? "dependencies"
                      : error.stage,
                "build.cause": error.message,
              }),
            ),
          ),
        ),
      asset: ({ build, path }) =>
        cloudBuildAsset(build, path).pipe(Effect.provide(RuntimeContext.phantom)),
      // Native fetch retains the upgrade response; Alchemy's typed HTTP stub omits it.
      changes: (app) =>
        dataChanges(Schema.decodeUnknownSync(NativeNamespace)(environment.AppDataSupervisor), app),
    });
    return runtimeAdapter(runtime);
  });
});
