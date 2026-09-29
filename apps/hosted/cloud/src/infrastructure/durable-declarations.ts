/**
 * Evaluated declarations and tool listings kept in each app's data supervisor, beside the app
 * cache that already holds its account-scoped upstream metadata, so every isolate shares them.
 */
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import type { DurableDeclarations } from "@executor-js/sdk/core";
import { EvaluatedEntry, evaluatedLimits } from "@executor-js/app-data/evaluated";
import type { AppDataSupervisor } from "./app-data.ts";

class CompressionFailed extends Schema.TaggedError<CompressionFailed>()("CompressionFailed", {}) {}

/**
 * A waking supervisor answers most reads in tens of milliseconds, and some in seconds. A read
 * slower than this costs about what the evaluation it would spare does, so it counts as a miss.
 */
const readMillis = 2_000;

const transform = (body: BodyInit, stream: CompressionStream | DecompressionStream) =>
  Effect.tryPromise({
    try: () => new Response(new Response(body).body?.pipeThrough(stream)).arrayBuffer(),
    catch: () => new CompressionFailed(),
  });

export const durableDeclarations = (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
): DurableDeclarations => ({
  get: (app, key) =>
    Effect.gen(function* () {
      const reply = yield* databases
        .getByName(app)
        .evaluated({ operation: "read", key })
        .pipe(Effect.provide(RuntimeContext.phantom));
      const entry = yield* Schema.decodeUnknownEffect(EvaluatedEntry)(reply);
      yield* Effect.annotateCurrentSpan("storage.evaluated.found", entry !== null);
      if (entry === null) return undefined;
      const text = new TextDecoder().decode(
        yield* transform(Uint8Array.from(entry.body), new DecompressionStream("gzip")),
      );
      return { at: entry.at, json: text };
    }).pipe(
      Effect.timeout(readMillis),
      Effect.catchCause(() => Effect.succeed(undefined)),
      Effect.withSpan("storage.evaluated.read"),
    ),
  set: (app, key, entry) =>
    Effect.gen(function* () {
      const body = new Uint8Array(yield* transform(entry.json, new CompressionStream("gzip")));
      yield* Effect.annotateCurrentSpan("storage.evaluated.bytes", body.byteLength);
      if (body.byteLength > evaluatedLimits.entryBytes) return;
      yield* databases
        .getByName(app)
        .evaluated({ operation: "write", key, at: entry.at, until: entry.until, body })
        .pipe(Effect.provide(RuntimeContext.phantom));
    }).pipe(
      Effect.catchCause(() => Effect.logWarning("Evaluated result was not kept")),
      Effect.withSpan("storage.evaluated.write"),
    ),
});
