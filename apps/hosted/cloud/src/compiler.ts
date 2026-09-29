/** Private compiler entry point. The esbuild WASM module belongs only to this Worker. */
import { RuntimeBuildFailed, SourceFiles } from "@executor-js/sdk/core";
import { CloudCompileResult } from "./contracts/builds.ts";
import { withRemoteSpan } from "@executor-js/telemetry";
import { Config, Effect, Option, Schema } from "effect";
import { compileCloudApp } from "./implementation/app-build.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { AppCompiler } from "./infrastructure/compiler.ts";

export default AppCompiler.make(
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
  Effect.gen(function* () {
    // Resolved during initialization so Alchemy binds it into the Worker environment. Only local
    // Cloud development and tests set it; deployed stages use the public registry.
    const registry = Option.getOrUndefined(
      yield* Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option),
    );
    return AppCompiler.of({
      compile: (files, headers) =>
        Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
          Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
          Effect.flatMap((files) => compileCloudApp(files, registry)),
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTags({
            RuntimeBuildFailed: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeProtocolUnsupported: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeAppsDependencyMissing: (error) => Effect.succeed({ ok: false as const, error }),
          }),
          Effect.flatMap(Schema.encodeEffect(CloudCompileResult)),
          Effect.orDie,
          withRemoteSpan(new Request("https://compiler.internal", { headers }), "compiler.compile"),
        ),
    });
  }).pipe(Effect.provide(cloudTelemetry)),
);
