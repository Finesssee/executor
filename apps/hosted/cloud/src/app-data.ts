/**
 * Private entry point for app data supervisors. A supervisor that wakes in a fresh isolate loads
 * and initializes only this Worker, not the API with its routes, auth and executor.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Effect, Layer, Schema } from "effect";
import {
  makeFacetSupervisor,
  FacetInvocation,
  type FacetBundle,
} from "@executor-js/app-data/cloudflare";
import { AppData } from "./infrastructure/app-data-worker.ts";
import { AppDataSupervisor } from "./infrastructure/app-data.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";

const NativeLoader = Schema.declare(
  (value): value is Pick<WorkerLoader, "get"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function",
);

const AppDataSupervisorLive = AppDataSupervisor.make(
  Effect.gen(function* () {
    // Alchemy provisions the binding. Its current wrapper does not expose getDurableObjectClass.
    yield* Cloudflare.WorkerLoader("AppDataLoader");
    const state = yield* Cloudflare.DurableObjectState;
    const environment = yield* Cloudflare.WorkerEnvironment;
    return Effect.gen(function* () {
      const loader = yield* Schema.decodeUnknownEffect(NativeLoader)(
        environment.AppDataLoader,
      ).pipe(Effect.orDie);
      const supervisor = yield* makeFacetSupervisor(state.raw, loader);
      return {
        cache: supervisor.cache,
        evaluated: supervisor.evaluated,
        invoke: (
          input: typeof FacetInvocation.Type,
          load: () => Promise<typeof FacetBundle.Type>,
          elicitation: ((input: unknown) => Promise<unknown>) | null = null,
          workflows: ((input: unknown) => Promise<unknown>) | null = null,
        ) => supervisor.invoke(input, load, elicitation, workflows),
        cancel: (id: string) => supervisor.cancel(id),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          // upgrade already accepts the socket; send the initial revision without accepting twice.
          yield* supervisor.initial(socket.ws).pipe(Effect.orDie);
          return response;
        }),
        alarm: () => supervisor.recover.pipe(Effect.orDie),
        webSocketMessage: () => Effect.void,
        webSocketClose: (socket: Cloudflare.WebSocket) => socket.close(1000, "Closed"),
        webSocketError: (socket: Cloudflare.WebSocket) => socket.close(1011, "Reconnect"),
      };
    });
  }),
);

export default AppData.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.succeed({}).pipe(Effect.provide(Layer.mergeAll(AppDataSupervisorLive, cloudTelemetry))),
);
