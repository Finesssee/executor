/** Generate the Executor app's authoring skills and framework reference for Cloud. */
import { generateFrameworkReference } from "../../../../packages/apps/scripts/reference.mjs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path } from "effect";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
    yield* fs.makeDirectory(path.join(root, "apps/hosted/cloud/.generated"), { recursive: true });
    const directory = path.join(root, "packages/app-templates/executor/skills/app-authoring");
    const files = yield* Effect.forEach(
      (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".md")),
      (name) =>
        fs
          .readFileString(path.join(directory, name))
          .pipe(Effect.map((content) => [`skills/app-authoring/${name}`, content] as const)),
    );
    const reference = yield* Effect.promise(() => generateFrameworkReference());
    yield* fs.writeFileString(
      path.join(root, "apps/hosted/cloud/.generated/executor-authoring.json"),
      JSON.stringify({
        ...Object.fromEntries(files),
        "framework-reference.json": JSON.stringify(reference),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
