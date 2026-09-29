/** Static source assets shared by ordinary local and hosted Executor apps. */
import { SourceFile } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path } from "effect";
import { TemplateError } from "../contracts/templates.ts";

/** Authoring skill files and the framework reference the management API serves. */
export const executorSkillFiles = (
  assets: Readonly<Record<string, string>>,
): readonly SourceFile[] =>
  Object.entries(assets).map(([path, content]) => SourceFile.make({ path, content }));

/** Node hosts read the same package assets that Workers embed at build time. */
export const readExecutorSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* path.fromFileUrl(
    new URL(
      import.meta.resolve("@executor-js/app-templates/executor/skills/app-authoring/SKILL.md"),
    ),
  );
  const directory = path.dirname(entry);
  const files = yield* Effect.forEach(
    (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".md")),
    (name) =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map((content) => [`skills/app-authoring/${name}`, content] as const)),
  );
  const reference = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(import.meta.resolve("apps/framework-reference.json"))),
  );
  return executorSkillFiles({
    ...Object.fromEntries(files),
    "framework-reference.json": reference,
  });
}).pipe(
  Effect.mapError(
    () =>
      new TemplateError({
        code: "authoring_reference",
        reason: "Build apps before loading the Executor authoring reference.",
      }),
  ),
);
