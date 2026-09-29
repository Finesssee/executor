/** Trusted Node adapter. Each cache transaction opens and closes its own SQLite handle. */
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Path, Schema } from "effect";
import { cacheKey, CacheCommand, CacheError, CacheReply, holdLeases } from "@executor-js/app-cache";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { discardsEvaluated } from "@executor-js/app-cache/changes";
import { isolatedCacheSession } from "apps/host";

/**
 * Bind persistent storage to an app/build; refreshes are bounded and owned by the returned
 * session. `changed` runs after each command that invalidated retained data.
 */
export const nodeCacheSession = (
  directory: string,
  app: string,
  build: string,
  changed: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appKey = yield* cacheKey(app);
    const root = path.join(directory, "cache");
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(() => new CacheError({ reason: "storage" })));
    const filename = path.join(root, `${appKey}.sqlite`);
    const store = (command: CacheCommand) =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Effect.acquireRelease(
            Effect.try({
              try: () => new DatabaseSync(filename),
              catch: () => new CacheError({ reason: "storage" }),
            }),
            (db) => Effect.sync(() => db.close()),
          );
          db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
          const cache = sqliteCache({
            sql: {
              exec: (query, ...bindings) => {
                const rows = db.prepare(query).all(...bindings);
                return {
                  toArray: () => rows,
                  one: () => {
                    if (rows.length !== 1) throw new Error("Expected one SQL result");
                    return rows[0];
                  },
                };
              },
            },
            transactionSync: (work) => {
              db.exec("BEGIN IMMEDIATE");
              try {
                const result = work();
                db.exec("COMMIT");
                return result;
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            },
          });
          const reply = yield* cache(build, command);
          if (discardsEvaluated(command)) yield* changed;
          return reply;
        }),
      );
    // The session owns the leases it claims until it drains or is cancelled.
    const leases = yield* holdLeases(store);
    const session = isolatedCacheSession((command) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(CacheCommand)(command).pipe(
          Effect.mapError(() => new CacheError({ reason: "invalid" })),
          Effect.flatMap(leases.transport),
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
          Effect.flatMap(Schema.encodeEffect(CacheReply)),
        ),
      ),
    );
    const settle = (work: () => Promise<void>) => async () => {
      try {
        await work();
      } finally {
        await Effect.runPromise(leases.close);
      }
    };
    return { ...session, drain: settle(session.drain), cancel: settle(session.cancel) };
  });
