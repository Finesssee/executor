/** Private cache of immutable executable builds. Invocation context never enters this store. */
import { type BuildId, type RuntimeBuildUnavailable } from "@executor-js/sdk/core";
import { RetainedWorkerBuild } from "@executor-js/sdk/workerd";
import { Effect, FiberSet, Schema } from "effect";
import { isolateBuildCacheSize } from "../contracts/builds.ts";

class BuildCacheFailed extends Schema.TaggedError<BuildCacheFailed>()("BuildCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new BuildCacheFailed() });
const encodedBuild = Schema.fromJsonString(RetainedWorkerBuild);
type Build = typeof RetainedWorkerBuild.Type;

// Decoded builds for this isolate, least recently used first. Build IDs are immutable and the
// values are code and build metadata only, so any invocation in the isolate may reuse them.
const builds = new Map<BuildId, { readonly build: Build; readonly wasm: number }>();
// Module source shared across builds, keyed by its text. Builds compiled with the same framework
// hold one copy of its modules; the count is how many retained builds use the source.
const sources = new Map<string, { readonly source: string; users: number }>();
let retained = 0;

const sourceOf = (module: Build["modules"][string]) =>
  typeof module === "string" ? module : "js" in module ? module.js : undefined;
const sizeOf = (module: Build["modules"][string]) =>
  typeof module === "string"
    ? module.length
    : "js" in module
      ? module.js.length
      : module.wasm.byteLength;

const release = (build: Build, wasm: number) => {
  retained -= wasm;
  for (const module of Object.values(build.modules)) {
    const text = sourceOf(module);
    const shared = text === undefined ? undefined : sources.get(text);
    if (shared === undefined) continue;
    shared.users -= 1;
    if (shared.users > 0) continue;
    sources.delete(shared.source);
    retained -= shared.source.length;
  }
};

const recall = (id: BuildId) => {
  const entry = builds.get(id);
  if (entry === undefined) return undefined;
  builds.delete(id);
  builds.set(id, entry);
  return entry.build;
};

/** Retain one decoded build, sharing identical module source, then evict to the size bound. */
const remember = (id: BuildId, build: Build) => {
  const present = recall(id);
  if (present !== undefined) return present;
  // One oversized build would evict every other entry and still not fit.
  const size = Object.values(build.modules).reduce((total, module) => total + sizeOf(module), 0);
  if (size > isolateBuildCacheSize) return build;
  let wasm = 0;
  const share = (text: string) => {
    const shared = sources.get(text);
    if (shared !== undefined) {
      shared.users += 1;
      return shared.source;
    }
    sources.set(text, { source: text, users: 1 });
    retained += text.length;
    return text;
  };
  const shared = {
    ...build,
    modules: Object.fromEntries(
      Object.entries(build.modules).map(([name, module]) => {
        if (typeof module === "string") return [name, share(module)];
        if ("js" in module) return [name, { js: share(module.js) }];
        wasm += module.wasm.byteLength;
        return [name, module];
      }),
    ),
  };
  builds.set(id, { build: shared, wasm });
  retained += wasm;
  for (const [oldest, entry] of builds) {
    if (retained <= isolateBuildCacheSize) break;
    builds.delete(oldest);
    release(entry.build, entry.wasm);
  }
  return shared;
};

/** Own writes in the event scope; return a loader that falls back to authoritative storage.
 * A build already decoded in this isolate needs neither the Cache API nor R2.
 */
export const cachedRuntimeBuilds = <R>(
  origin: string,
  load: (build: BuildId) => Effect.Effect<Build, RuntimeBuildUnavailable, R>,
) =>
  Effect.gen(function* () {
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    return (build: BuildId) =>
      Effect.gen(function* () {
        const memory = recall(build);
        if (memory !== undefined) {
          yield* Effect.annotateCurrentSpan("executor.build.cache", "memory");
          return memory;
        }
        // Separate from browser assets. No route serves this synthetic URL.
        const key = new URL(`/_executor/runtime-build-cache/${encodeURIComponent(build)}`, origin)
          .href;
        const cache = yield* cached(() => caches.open("executor-private-runtime-builds-v1")).pipe(
          Effect.catchTag("BuildCacheFailed", () => Effect.succeed(undefined)),
        );
        const hit =
          cache === undefined
            ? undefined
            : yield* cached(() => cache.match(key)).pipe(
                Effect.flatMap((response) =>
                  response === undefined
                    ? Effect.succeed(undefined)
                    : cached(() => response.text()).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(encodedBuild)),
                      ),
                ),
                Effect.catchTags({
                  BuildCacheFailed: () => Effect.succeed(undefined),
                  SchemaError: () => Effect.succeed(undefined),
                }),
              );
        yield* Effect.annotateCurrentSpan(
          "executor.build.cache",
          hit === undefined ? "miss" : "hit",
        );
        if (hit !== undefined) return remember(build, hit);
        const bundle = yield* load(build);
        if (cache !== undefined) {
          // Encode only the retained code/metadata schema. Credentials, query results,
          // bindings, account identity and authorization are supplied per invocation.
          yield* FiberSet.run(
            writes,
            Schema.encodeEffect(encodedBuild)(bundle).pipe(
              Effect.flatMap((body) =>
                cached(() =>
                  cache.put(
                    key,
                    new Response(body, {
                      headers: {
                        "content-type": "application/json",
                        "cache-control": "public, max-age=31536000",
                      },
                    }),
                  ),
                ),
              ),
              Effect.catchTags({
                BuildCacheFailed: () => Effect.logWarning("Runtime build cache write failed"),
                SchemaError: () => Effect.logWarning("Runtime build cache encoding failed"),
              }),
            ),
          );
        }
        return remember(build, bundle);
      }).pipe(
        Effect.tap(() => Effect.annotateCurrentSpan("executor.build.isolate_size", retained)),
        Effect.withSpan("runtime.cloud.build.cached"),
      );
  });
