/** Compile server and browser source inside workerd using Cloudflare's dependency resolver. */
import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import {
  boundBuildMessage,
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
} from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import { prepareUiBuild } from "./ui-build.ts";
import { Effect, Option, Path, Schema } from "effect";
import type { Plugin } from "esbuild";
import {
  PublishedAppFramework,
  WorkerBundle,
  type AppFramework,
} from "../contracts/worker-build.ts";
import { appProtocol } from "./app-protocols.ts";
import { browserBuild } from "./worker-browser-build.ts";
import { wasmBuild } from "./worker-wasm-build.ts";
import { workerDependencies } from "./worker-dependencies.ts";
import apps from "apps/package.json" with { type: "json" };
export type WorkerFramework = AppFramework;

/**
 * What the compiling host contributes. `registry` replaces the public npm registry. A host has no
 * framework of its own: every source declares the `apps` release it uses in `dependencies.apps`.
 */
export interface WorkerHost {
  readonly registry?: string;
}

const frameworkExports = [
  "apps",
  "apps/host",
  "apps/storage/facet",
  "apps/contracts",
  "apps/mcp",
  "apps/graphql",
  "apps/openapi",
  "apps/skills",
  "apps/skills/effect",
  "apps/operations/approval",
];
const frameworkModules = (framework: AppFramework["server"]) => ({
  ...Object.fromEntries(Object.entries(framework).filter(([name]) => name.endsWith(".js"))),
  ...Object.fromEntries(
    frameworkExports.map((name) => [
      name,
      {
        js: `export * from "${name === "apps" ? "./" : "../".repeat(name.split("/").length - 1)}node_modules/apps/${name === "apps" ? "index" : name.slice(5)}.js";`,
      },
    ]),
  ),
});
const quietCompiler: Plugin = {
  name: "private-build-diagnostics",
  setup(build) {
    build.initialOptions.logLevel = "silent";
  },
};

const EsbuildFailure = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      location: Schema.NullOr(
        Schema.Struct({ file: Schema.String, line: Schema.Int, column: Schema.Int }),
      ),
    }),
  ),
});
/** The bundler reads source from its `virtual:` namespace; report the authored path. */
const sourcePath = (file: string) => file.replace(/^virtual:/, "");
/** Shown compiler errors; the rest are counted. */
const shownCompileErrors = 5;

/** Keep the compiler's own errors and the first failing location for the deployer. */
const compileFailure = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(EsbuildFailure)(cause), {
    onNone: () => new RuntimeBuildFailed({ stage: "compile", message: describeBuildCause(cause) }),
    onSome: ({ errors }) => {
      const first = errors[0]?.location ?? undefined;
      const lines = errors
        .slice(0, shownCompileErrors)
        .map(({ text, location }) =>
          location === null
            ? text
            : `${sourcePath(location.file)}:${location.line}:${location.column}: ${text}`,
        );
      const more = errors.length - lines.length;
      return new RuntimeBuildFailed({
        stage: "compile",
        message: boundBuildMessage(
          [...lines, ...(more > 0 ? [`(${more} more errors)`] : [])].join("\n") ||
            describeBuildCause(cause),
        ),
        ...(first === undefined
          ? {}
          : {
              location: { file: sourcePath(first.file), line: first.line, column: first.column },
            }),
      });
    },
  });

const selectedFramework = (filesystem: InMemoryFileSystem) =>
  Effect.gen(function* () {
    const selected = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PublishedAppFramework),
    )(filesystem.read("node_modules/apps/runtime.json"));
    for (const modules of [selected.server, selected.browser]) {
      if (
        Object.keys(modules).some(
          (name) =>
            !name.startsWith("node_modules/apps/") ||
            !name.endsWith(".js") ||
            name.split("/").includes(".."),
        )
      )
        return yield* new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" });
    }
    return selected;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(RuntimeBuildFailed)(error)
        ? error
        : new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" }),
    ),
  );

/**
 * Compilation returns browser bytes separately; neither imports nor credentials cross from server
 * execution. The selected framework's protocol must be supported before anything compiles.
 */
export const compileWorkerApp = (files: SourceFiles, host: WorkerHost) =>
  Effect.gen(function* () {
    const vendored = files.find((file) => file.path.split("/").includes("node_modules"));
    if (vendored !== undefined)
      return yield* new RuntimeBuildFailed({
        stage: "source",
        location: { file: vendored.path },
        message:
          "Source files cannot include node_modules. Declare packages in package.json dependencies; the build installs them.",
      });
    const filesystem = new InMemoryFileSystem(
      Object.fromEntries(files.map((file) => [file.path, file.content])),
    );
    const dependencies = yield* workerDependencies(filesystem, host.registry);
    if (!(yield* dependencies.framework))
      return yield* new RuntimeAppsDependencyMissing({ version: apps.version });
    const selected = yield* selectedFramework(filesystem);
    const protocol = yield* appProtocol(selected.protocol);
    filesystem.write("__executor_worker.ts", protocol.workerEntry(files));
    const plan = yield* prepareUiBuild(files);
    const browser =
      plan === undefined
        ? undefined
        : yield* browserBuild(files, filesystem, plan, selected.browser);
    const wasm = wasmBuild(filesystem, yield* Path.Path);
    const compiled = yield* Effect.tryPromise({
      try: () =>
        createApp({
          files: filesystem,
          installDependencies: false,
          server: "__executor_worker.ts",
          externals: frameworkExports,
          minify: true,
          jsx: "automatic",
          define: { "process.env.NODE_ENV": '"production"' },
          ...(plan === undefined ? {} : { client: [...plan.entries] }),
          __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
            quietCompiler,
            dependencies.plugin,
            wasm.plugin,
            ...(browser === undefined ? [] : [browser.plugin]),
          ],
        }),
      catch: compileFailure,
    });
    const bundle = yield* Schema.decodeUnknownEffect(Schema.toType(WorkerBundle))({
      ...compiled,
      modules: { ...compiled.modules, ...frameworkModules(selected.server), ...wasm.modules },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeBuildFailed({
            stage: "compile",
            message: boundBuildMessage(
              `The compiled bundle is invalid: ${describeBuildCause(cause)}`,
            ),
          }),
      ),
    );
    const ui = browser === undefined ? undefined : yield* browser.finish();
    return { bundle, ui, protocol: selected.protocol };
  }).pipe(Effect.provide(Path.layer), Effect.withSpan("runtime.cloud.compile"));
