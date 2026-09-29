/**
 * The app Workers one workerd process keeps loaded. The pinned workerd never unloads a named
 * Worker Loader entry by itself, so without a bound every app and account selection a process ever
 * called stays resident, and memory grows with them. A host that owns its workerd process gives
 * its runner this residency: it counts the calls in flight in each named Worker and, whenever more
 * Workers are loaded than the configured limit, unloads the least recently used idle ones. A Worker
 * with a call in flight, including an unfinished release, a paused elicitation or a running
 * workflow, is never unloaded, so no work is lost (a release that outlives its limit keeps its
 * hold until it settles); while every loaded Worker is busy the limit is
 * exceeded until calls finish. The next call of an unloaded Worker cold-starts it from its build.
 *
 * The state lives in the runner's own isolate, which workerd keeps for the life of the process.
 * Cloud has no residency: Cloudflare unloads its Workers itself.
 */
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Clock, Config, type Context, Effect, Option, Schema } from "effect";
import { replaceWorker, unloadWorker } from "@executor-js/app-data/cloudflare";

/** Loaded app Workers a self-host or local process keeps when no limit is configured. */
export const defaultAppWorkerLimit = 32;
/**
 * The operator's limit on loaded app Workers, `EXECUTOR_APP_WORKERS`. Each loaded Worker holds its
 * own isolate, so this bounds the memory app code uses however many apps and accounts are called.
 */
export const appWorkerLimit = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  "EXECUTOR_APP_WORKERS",
).pipe(Config.option);
/** An unload that has not settled by then is abandoned; its name then loads fresh code. */
const unloadLimit = "10 seconds";

interface Resident {
  active: number;
  lastUsed: number;
  unloading: Promise<void> | undefined;
}

export interface AppWorkerResidency {
  /**
   * Hold a named Worker for one call. Waits while the name is being unloaded, and unloads idle
   * Workers above the limit before the call loads its own. Returns the call's release.
   */
  readonly hold: (
    loader: Pick<WorkerLoader, "get">,
    name: string,
  ) => Effect.Effect<Effect.Effect<void>>;
}

export const makeAppWorkerResidency = (limit: number): AppWorkerResidency => {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("The app Worker limit must be a positive integer");
  const residents = new Map<string, Resident>();

  const unload = (loader: Pick<WorkerLoader, "get">, name: string, resident: Resident) =>
    Effect.promise(() => unloadWorker(loader, name)).pipe(
      Effect.timeoutOption(unloadLimit),
      Effect.tap((settled) =>
        Effect.sync(() => {
          // The runtime may still hold the old Worker; later calls must not reach it.
          if (Option.isNone(settled)) replaceWorker(name);
        }),
      ),
      Effect.tap((settled) =>
        Effect.annotateCurrentSpan({
          "executor.worker.identity": name,
          "executor.worker.unloaded": Option.getOrElse(settled, () => false),
          "executor.worker.unload_timed_out": Option.isNone(settled),
        }),
      ),
      Effect.withSpan("runtime.app.worker.unload"),
      Effect.asVoid,
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          if (residents.get(name) === resident) residents.delete(name);
        }),
      ),
    );

  /** Unload least recently used idle Workers until at most `limit` stay loaded. */
  const trim = (loader: Pick<WorkerLoader, "get">) =>
    Effect.contextWith((services: Context.Context<never>) => {
      let loaded = 0;
      const idle: Array<[string, Resident]> = [];
      for (const entry of residents) {
        if (entry[1].unloading !== undefined) continue;
        loaded++;
        if (entry[1].active === 0) idle.push(entry);
      }
      idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const unloads: Array<Promise<void>> = [];
      for (const [name, resident] of idle) {
        if (loaded <= limit) break;
        loaded--;
        // Claimed synchronously, so a call of this name waits instead of reaching the old Worker.
        const unloading = Effect.runPromiseWith(services)(unload(loader, name, resident));
        resident.unloading = unloading;
        unloads.push(unloading);
      }
      return unloads.length === 0 ? Effect.void : Effect.promise(() => Promise.all(unloads));
    });

  const hold = (loader: Pick<WorkerLoader, "get">, name: string) =>
    Effect.gen(function* () {
      let resident: Resident | undefined;
      while (resident === undefined) {
        const now = yield* Clock.currentTimeMillis;
        // Checked and claimed without yielding, so an unload cannot start in between.
        const current = residents.get(name);
        if (current?.unloading !== undefined) {
          const pending = current.unloading;
          yield* Effect.promise(() => pending);
          continue;
        }
        resident = current ?? {
          active: 0,
          lastUsed: now,
          unloading: undefined,
        };
        resident.active++;
        resident.lastUsed = now;
        residents.set(name, resident);
      }
      const held = resident;
      yield* trim(loader);
      let released = false;
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.suspend(() => {
            if (released) return Effect.void;
            released = true;
            held.active--;
            held.lastUsed = now;
            return trim(loader);
          }),
        ),
      );
    });

  return { hold };
};
