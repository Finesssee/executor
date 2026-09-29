/**
 * The product side of app execution, shared by every host. It turns runtime operations into app
 * invocations for the runner, gives each invocation a build loader over the host's build store,
 * and decodes the reply. Hosts differ only in where the runner lives and how builds are stored.
 */
import { Effect, Option, Redacted, Result, Schema, type Stream } from "effect";
import { makeTelemetryForwarder, TelemetryBatch, traceHeaders } from "@executor-js/telemetry";
import {
  HostCallError,
  HostDataError,
  HostedTool,
  HostedToolSummary,
  HostInspectError,
  HostResponse,
  indexCommand,
  inspectCommand,
  selectTools,
  skillCatalog,
  SkillCatalogResponse,
  skillsCommand,
  ToolResultObservation,
  type HostContext,
  type HostRequest,
} from "apps/contracts";
import {
  AppCacheChanges,
  RuntimeProtocolFailed,
  type Runtime,
  type RuntimeBuildUnavailable,
} from "../contracts/runtime.ts";
import { Json, type BuildId } from "../contracts/shared.ts";
import type { WorkerBundle } from "../contracts/worker-build.ts";
import type { BlobStore } from "../contracts/blobs.ts";
import { appWorker, type AppCapabilities, type AppInvocation } from "./app-runner.ts";
import { invocationElicitation } from "./worker-elicitation.ts";
import { invocationWorkflowControls } from "./worker-workflow-rpc.ts";

/** The span recorded each time a host reads a build for a cold start. */
export const buildLoadSpan = "runtime.app.build.load";

/** What one host provides. Everything else about app execution is shared. */
export interface AppRuntimeHost {
  /** Span prefix for this host's runtime operations. */
  readonly name: string;
  /** Read one retained build from this host's store. */
  readonly loadBuild: (
    build: BuildId,
  ) => Effect.Effect<WorkerBundle, RuntimeBuildUnavailable, BlobStore>;
  /** Deliver one invocation to the runner, wherever it runs. */
  readonly invoke: (
    invocation: AppInvocation,
    capabilities: AppCapabilities,
  ) => Effect.Effect<unknown, RuntimeProtocolFailed>;
  readonly build: Runtime<BlobStore>["build"];
  readonly asset: NonNullable<Runtime<BlobStore>["asset"]>;
  readonly changes: (app: string) => Stream.Stream<number, RuntimeProtocolFailed>;
}

/** Assemble runtime operations over one host's runner and build store. */
export const appRuntime = (host: AppRuntimeHost) =>
  Effect.gen(function* () {
    const forward = yield* makeTelemetryForwarder;
    const dispatch = <A, E>(
      input: {
        readonly app: string;
        readonly build: BuildId;
        readonly database: boolean;
        readonly observeRevision?: (revision: number) => void;
      } & HostContext,
      command: HostRequest,
      output: Schema.Decoder<A>,
      errors: Schema.Decoder<E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (input.storage !== undefined) return yield* new RuntimeProtocolFailed();
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const services = yield* Effect.context<BlobStore>();
          const build = input.build;
          const invocation: AppInvocation = {
            app: input.app,
            build,
            database: input.database,
            command,
            accounts: Redacted.value(input.accounts),
            // Workers RPC structured-clones its arguments; Effect headers carry a prototype it rejects.
            headers: Object.fromEntries(Object.entries(yield* traceHeaders)),
            ...(input.approval === undefined ? {} : { approval: input.approval }),
            ...(input.replay === undefined ? {} : { replay: input.replay }),
            ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
          };
          const worker = yield* appWorker(invocation).pipe(
            Effect.mapError(() => new RuntimeProtocolFailed()),
          );
          const body = yield* host.invoke(invocation, {
            // Only a cold start calls this, inside the trusted runner or data supervisor.
            load: () =>
              Effect.runPromiseWith(services)(
                host.loadBuild(build).pipe(
                  Effect.withSpan(buildLoadSpan, {
                    attributes: {
                      "executor.app.id": input.app,
                      "executor.build.id": build,
                      "executor.runtime.mode": worker.mode,
                      "executor.worker.identity": worker.name,
                    },
                  }),
                ),
                { signal: lifetime.signal },
              ),
            elicit:
              input.elicitation === undefined
                ? null
                : invocationElicitation(input.elicitation, lifetime.signal),
            controls:
              input.workflowControls === undefined
                ? null
                : yield* invocationWorkflowControls(input.workflowControls, lifetime.signal),
            ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
          });
          // Telemetry is an additive transport field. Retained builds keep their original protocol.
          const collected = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              telemetry: Schema.optional(TelemetryBatch),
              executorRevision: Schema.optional(Schema.Int),
              cacheChanged: Schema.optional(Schema.Boolean),
            }),
          )(body).pipe(Effect.result);
          if (Result.isFailure(collected)) yield* Effect.logWarning("Invalid app telemetry batch");
          if (Result.isSuccess(collected) && collected.success.telemetry !== undefined) {
            const span = yield* Effect.currentSpan.pipe(Effect.option);
            if (Option.isSome(span))
              yield* forward(collected.success.telemetry, span.value.traceId, build);
          }
          if (Result.isSuccess(collected) && collected.success.cacheChanged === true)
            yield* (yield* AppCacheChanges).changed(input.app);
          const reply = yield* Schema.decodeUnknownEffect(HostResponse)(body);
          if (!reply.ok)
            return yield* Schema.decodeUnknownEffect(errors)(reply.error).pipe(
              Effect.flatMap(Effect.fail),
            );
          if (reply.toolError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          const value = yield* Schema.decodeUnknownEffect(output)(reply.value);
          const revision = Result.isSuccess(collected)
            ? collected.success.executorRevision
            : undefined;
          if (command.operation === "query" && revision !== undefined)
            input.observeRevision?.(revision);
          return value;
        }),
      ).pipe(Effect.catchTag("SchemaError", () => Effect.fail(new RuntimeProtocolFailed())));
    const span = (operation: string) => `${host.name}.${operation}`;
    return {
      build: (input) => host.build(input).pipe(Effect.withSpan(span("build"))),
      asset: host.asset,
      changes: host.changes,
      skills: ({ sources, ...input }) =>
        dispatch(
          { ...input, database: false },
          skillsCommand(sources === true),
          SkillCatalogResponse,
          HostInspectError,
        ).pipe(Effect.map(skillCatalog), Effect.withSpan(span("skills"))),
      inspect: ({ tools, scheduled, ...input }) =>
        dispatch(
          { ...input, database: false },
          inspectCommand(tools, scheduled),
          Schema.Array(HostedTool),
          HostInspectError,
        ).pipe(Effect.map(selectTools(tools)), Effect.withSpan(span("inspect"))),
      index: (input) =>
        dispatch(
          { ...input, database: false },
          indexCommand,
          Schema.Array(HostedToolSummary),
          HostInspectError,
        ).pipe(Effect.withSpan(span("index"))),
      query: (input) =>
        dispatch(
          input,
          { operation: "query", name: input.name, input: input.input },
          Json,
          HostDataError,
        ).pipe(Effect.withSpan(span("query"))),
      mutate: (input) =>
        dispatch(
          input,
          { operation: "mutate", name: input.name, input: input.input },
          Json,
          HostDataError,
        ).pipe(Effect.withSpan(span("mutate"))),
      call: (input) =>
        dispatch(
          input,
          { operation: "call", tool: input.tool, input: input.input },
          Json,
          HostCallError,
        ).pipe(Effect.withSpan(span("call"))),
      webhook: (input) =>
        dispatch(input, input.command, Json, HostCallError).pipe(Effect.withSpan(span("webhook"))),
      workflow: (input) =>
        dispatch({ ...input, database: false }, input.command, Json, HostCallError).pipe(
          Effect.withSpan(span("workflow"), {
            attributes: {
              "executor.app.id": input.app,
              "executor.build.id": input.build,
              ...(input.workflow === undefined ? {} : { "executor.run.id": input.workflow.runId }),
            },
          }),
        ),
    } satisfies Runtime<BlobStore>;
  });
