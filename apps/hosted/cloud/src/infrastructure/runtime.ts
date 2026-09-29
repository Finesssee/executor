/** Cloud's app runtime: the shared runner in the API Worker, with R2 and the Cache API as build store. */
import { CacheCommand, changesCache } from "@executor-js/app-cache/contracts";
import { traceHeaders } from "@executor-js/telemetry";
import {
  AppCacheChanges,
  BuildId,
  RuntimeBuildFailed,
  BuildMemoryExceeded,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { appRuntime, makeAppRunner } from "@executor-js/sdk/workerd";
import { HostRequirementsError, DeclaredRequirements, HostResponse } from "apps/contracts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import type { AppDataSupervisor } from "./app-data.ts";
import { dataChanges } from "../implementation/data-changes.ts";
import { cachedRuntimeBuilds } from "../implementation/runtime-build-cache.ts";
import type { DurableObjectNamespace, Fetcher, WorkerLoader } from "@cloudflare/workers-types";
import { CompiledCloudApp } from "../contracts/builds.ts";
import { AppCompiler } from "./compiler.ts";
import { AppOutbound } from "./app-outbound.ts";
import {
  loadCloudBuild,
  retainCloudBuild,
  cloudBuildAsset,
} from "../implementation/build-storage.ts";

/** Keep the underlying failure beside the public error so the build span can report it. */
const causes = new WeakMap<object, string>();
const causeOf = (error: unknown) =>
  (typeof error === "object" && error !== null ? causes.get(error) : undefined) ?? "";
const describe = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : (JSON.stringify(cause) ?? String(cause));
const failed = (stage: RuntimeBuildFailed["stage"], cause: unknown) => {
  const error = new RuntimeBuildFailed({ stage });
  causes.set(error, describe(cause));
  return error;
};
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
              if (changesCache(parsed)) yield* (yield* AppCacheChanges).changed(app);
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
        load(build).pipe(Effect.map(({ mainModule, modules }) => ({ mainModule, modules }))),
      invoke: runner.invoke,
      build: ({ files }) =>
        Effect.gen(function* () {
          const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
          const { bundle, ui } = yield* compiler.compile(files, headers).pipe(
            Effect.catchTag("RpcCallError", (error) => {
              const cause = error.cause;
              const failure =
                cause instanceof Error && /^Worker exceeded memory limit\.?$/.test(cause.message)
                  ? new BuildMemoryExceeded()
                  : new RuntimeBuildFailed({ stage: "compile" });
              causes.set(failure, describe(error));
              return Effect.fail(failure);
            }),
            Effect.flatMap(Schema.decodeUnknownEffect(CompiledCloudApp)),
            Effect.catchTag("SchemaError", (cause) => Effect.fail(failed("compile", cause))),
            Effect.withSpan("runtime.cloud.compiler.request"),
          );
          const build = BuildId.make(`bld_${crypto.randomUUID()}`);
          const requirements = yield* runner.declare(bundle, headers).pipe(
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
            { ...bundle, database: requirements.database !== undefined },
            ui,
          ).pipe(Effect.provide(RuntimeContext.phantom));
          return { build, requirements, ...(assets === undefined ? {} : { ui: assets }) };
        }).pipe(
          // The failing stage and its cause belong on the span; the public error stays small.
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan({
              "build.stage": Schema.is(BuildMemoryExceeded)(error) ? "compile" : error.stage,
              "build.cause": causeOf(error),
            }),
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
