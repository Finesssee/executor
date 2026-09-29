/** Evaluated tool listings, reused across requests through the declaration store. */
import { Clock, Deferred, Effect, Exit } from "effect";
import {
  defaultToolListingPolicy,
  type BackgroundWork,
  type DeclarationCache,
  type PendingLoad,
  type ToolListingPolicy,
} from "../contracts/declarations.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  ToolListingTimedOut,
  type AppEvaluationFailed,
  type AppProviderFailed,
  type Tool,
  type ToolListOptions,
} from "../contracts/tools.ts";
import type { DeploymentId, ProfileId } from "../contracts/shared.ts";
import type { Declarations } from "./declarations.ts";
import type { makeOAuth } from "./oauth.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";

/** Every tool of one app for one invocation state, sorted by name. */
export interface ToolListing {
  readonly catalog: {
    readonly deployment: DeploymentId;
    readonly profile?: ProfileId;
    readonly profileRevision?: number;
  };
  readonly items: ReadonlyArray<Tool>;
}
/** Failures of the evaluation itself. Credential and storage failures are never remembered. */
export type ListingFailure = AppEvaluationFailed | AppProviderFailed | ToolListingTimedOut;
type ResolveError = Effect.Error<ReturnType<typeof resolve>>;

/** What a finished evaluation left for its readers; only the first two are kept. */
class Listed {
  readonly listing: ToolListing;
  constructor(listing: ToolListing) {
    this.listing = listing;
  }
}
class Failed {
  readonly error: ListingFailure;
  /** When it failed; a remembered failure is reported for `freshMillis` from then. */
  readonly at: number;
  constructor(error: ListingFailure, at: number) {
    this.error = error;
    this.at = at;
  }
}
class Unkept {
  readonly error: ResolveError;
  constructor(error: ResolveError) {
    this.error = error;
  }
}
/** Interrupted before it finished, by its owning reader or by the host. */
class Stopped {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    this.elapsedMs = elapsedMs;
  }
}
type Outcome = Listed | Failed | Unkept | Stopped;

/**
 * Keep each evaluated listing in the shared declaration store under the declaration key, so a
 * new deployment, profile revision, account selection or stored credential is another listing,
 * and serve anything this read did not evaluate itself only after the checks a live evaluation
 * runs before it releases credentials: a kept listing, a remembered failure, and the result of
 * an evaluation another request started.
 *
 * A listing younger than `freshMillis` is served as is; an older one is served while one
 * background evaluation replaces it; past `maxStaleMillis` the read evaluates first. Readers of a
 * key share one evaluation. A first evaluation runs in the background when the host allows it,
 * so a reader that stops waiting, such as MCP discovery giving up on a stalled app, leaves it
 * running until `loadMillis`, and its listing is kept when it finishes. A reader that passes
 * `reportRunningAfterMillis` is told at once about an evaluation that has run longer than that,
 * or that such a reader already gave up on; other readers wait for it. A slow failure is reported
 * at once to such a reader for `freshMillis` after it failed, while one background evaluation at a
 * time retries; other readers evaluate again, so they never see a failure a live read would not. Kept listings are shared by reference and
 * never mutated, so consumers may derive projections that live exactly as long as the listing.
 */
export const makeListings = (options: {
  readonly cache: DeclarationCache;
  readonly background: BackgroundWork | undefined;
  readonly declarations: Declarations;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolve"];
  readonly lifecycle: ResourceLifecycle | undefined;
  readonly policy?: ToolListingPolicy;
}) => {
  const policy = options.policy ?? defaultToolListingPolicy;
  const { cache, background } = options;
  return {
    read: (
      state: InvocationSnapshot,
      evaluate: (
        context: Effect.Success<ReturnType<typeof resolve>>,
      ) => Effect.Effect<ToolListing, AppEvaluationFailed | AppProviderFailed>,
      read: ToolListOptions = {},
    ) =>
      Effect.gen(function* () {
        const identity = { app: state.app.id, deployment: state.deployment.id };
        const evaluated = resolve(state, options.resolveAccount, options.lifecycle).pipe(
          Effect.flatMap(evaluate),
        );
        if (policy.maxStaleMillis <= 0) return yield* evaluated;
        const id = yield* options.declarations.key("tools.list", state);
        const now = yield* Clock.currentTimeMillis;
        const authorize = options.declarations.authorize(state);
        const timedOut = (elapsedMs: number, running: boolean) =>
          new ToolListingTimedOut({ ...identity, elapsedMs, running });
        const pendingLoad = (started: number): PendingLoad => ({
          started,
          waiters: 0,
          overdue: false,
          unwatched: Deferred.makeUnsafe(),
          done: Deferred.makeUnsafe(),
        });

        /** Keep a listing, or a slow failure unless a listing that may still be served exists. */
        const keep = (outcome: Outcome, load: PendingLoad) =>
          Effect.gen(function* () {
            if (outcome instanceof Listed)
              return yield* cache.set(id, {
                kind: "value",
                app: state.app.id,
                at: load.started,
                value: outcome,
                bytes: JSON.stringify(outcome.listing.items).length * 2,
              });
            if (!(outcome instanceof Failed)) return;
            if (
              outcome.error._tag !== "ToolListingTimedOut" &&
              outcome.at - load.started < policy.slowFailureMillis
            )
              return;
            const current = yield* cache.get(id);
            if (
              current?.kind === "value" &&
              current.value instanceof Listed &&
              outcome.at - current.at < policy.maxStaleMillis
            )
              return;
            // Stamped with its start, so an app cache change during the evaluation discards it.
            yield* cache.set(id, {
              kind: "value",
              app: state.app.id,
              at: load.started,
              value: outcome,
              bytes: 0,
            });
          });
        /**
         * Stops the evaluation once it has run for `loadMillis` with no reader waiting: at that
         * point if nobody waits, otherwise when the last waiting reader leaves.
         */
        const unwatched = (load: PendingLoad) =>
          Effect.gen(function* () {
            yield* Effect.sleep(policy.loadMillis);
            if (load.waiters > 0) yield* Deferred.await(load.unwatched);
            const at = yield* Clock.currentTimeMillis;
            return new Failed(timedOut(at - load.started, false), at) as Outcome;
          });
        /** Evaluate once for every reader of this key, keeping the listing or its failure. */
        const run = (load: PendingLoad) =>
          evaluated.pipe(
            Effect.map((listing): Outcome => new Listed(listing)),
            Effect.catch((error) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((at): Outcome =>
                  error._tag === "AppEvaluationFailed" || error._tag === "AppProviderFailed"
                    ? new Failed(error, at)
                    : new Unkept(error),
                ),
              ),
            ),
            Effect.raceFirst(unwatched(load)),
            Effect.tap((outcome) => keep(outcome, load)),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                cache.end(id, load);
                if (Exit.isSuccess(exit)) return yield* Deferred.succeed(load.done, exit.value);
                // A host that ends background work before `loadMillis` stops a stalled listing
                // here; one stopped after running that long is remembered like a timeout.
                const at = yield* Clock.currentTimeMillis;
                if (at - load.started >= policy.loadMillis)
                  yield* keep(new Failed(timedOut(at - load.started, false), at), load);
                yield* Deferred.succeed(load.done, new Stopped(at - load.started));
              }),
            ),
            Effect.asVoid,
            Effect.withSpan("sdk.tools.listing.evaluate"),
            // Background work may start uninterruptible; its time bound must still stop it.
            Effect.interruptible,
          );
        /** Start an evaluation nobody waits for, unless one is running or the host refuses. */
        const refresh = Effect.uninterruptible(
          Effect.gen(function* () {
            if (background === undefined || cache.pending(id) !== undefined) return;
            const load = pendingLoad(yield* Clock.currentTimeMillis);
            cache.begin(id, load);
            if (yield* background(run(load))) return;
            cache.end(id, load);
            yield* Deferred.succeed(load.done, new Stopped(0));
          }),
        );
        const outcome = (value: unknown) =>
          Effect.gen(function* () {
            if (value instanceof Listed) return value.listing;
            if (value instanceof Failed || value instanceof Unkept)
              return yield* Effect.fail(value.error);
            const elapsed = value instanceof Stopped ? value.elapsedMs : 0;
            return yield* Effect.fail(timedOut(elapsed, false));
          });
        /**
         * Wait for an evaluation this read did not run itself, then check access as for a kept
         * listing: it may have been evaluated for another request, and access may have changed
         * while it ran. A reader that stops waiting leaves it running; one with a wait bound that
         * gives up after the evaluation has run for half that bound marks it overdue. A reader
         * interrupted sooner, such as a finished program, says nothing about the evaluation.
         */
        const join = (load: PendingLoad) =>
          Effect.gen(function* () {
            load.waiters += 1;
            const bound = read.reportRunningAfterMillis;
            const done = yield* Deferred.await(load.done).pipe(
              Effect.onInterrupt(() =>
                Clock.currentTimeMillis.pipe(
                  Effect.map((at) => {
                    if (bound !== undefined && at - load.started >= bound / 2) load.overdue = true;
                  }),
                ),
              ),
              Effect.ensuring(
                Effect.suspend(() => {
                  load.waiters -= 1;
                  return load.waiters === 0
                    ? Clock.currentTimeMillis.pipe(
                        Effect.flatMap((at) =>
                          at - load.started >= policy.loadMillis
                            ? Deferred.succeed(load.unwatched, undefined)
                            : Effect.void,
                        ),
                      )
                    : Effect.void;
                }),
              ),
              Effect.exit,
            );
            yield* authorize;
            if (Exit.isFailure(done)) return yield* Effect.failCause(done.cause);
            return yield* outcome(done.value);
          });

        const entry = yield* cache.get(id);
        const kept =
          entry?.kind === "value" &&
          (entry.value instanceof Listed || entry.value instanceof Failed)
            ? { at: entry.at, value: entry.value }
            : undefined;
        if (kept?.value instanceof Listed) {
          const age = now - kept.at;
          // Without background work a stale listing is evaluated again first, like a missing one.
          if (
            age < policy.freshMillis ||
            (age < policy.maxStaleMillis && background !== undefined)
          ) {
            yield* authorize;
            const stale = age >= policy.freshMillis;
            yield* Effect.annotateCurrentSpan({
              "executor.declarations.cache": stale ? "stale" : "hit",
              "executor.declarations.age_ms": age,
            });
            if (stale) yield* refresh;
            return kept.value.listing;
          }
        }
        // A remembered failure spares a reader with a wait bound, such as MCP discovery, from
        // waiting on the evaluation again. A reader prepared to wait, such as the dashboard,
        // joins or starts a live evaluation instead, so a recovered upstream shows at once.
        if (
          kept?.value instanceof Failed &&
          now - kept.value.at < policy.freshMillis &&
          read.reportRunningAfterMillis !== undefined
        ) {
          yield* authorize;
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "failed");
          yield* refresh;
          return yield* Effect.fail(kept.value.error);
        }
        const running = cache.pending(id);
        if (running !== undefined) {
          const elapsed = now - running.started;
          const bound = read.reportRunningAfterMillis;
          if (bound !== undefined && (running.overdue || elapsed >= bound)) {
            yield* authorize;
            yield* Effect.annotateCurrentSpan("executor.declarations.cache", "running");
            return yield* Effect.fail(timedOut(elapsed, true));
          }
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "joined");
          return yield* join(running);
        }
        // Checking for a running evaluation and registering this one happen without yielding.
        const load = pendingLoad(now);
        cache.begin(id, load);
        yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
        const detached =
          background === undefined ? false : yield* Effect.uninterruptible(background(run(load)));
        if (detached) return yield* join(load);
        // Without background work the evaluation belongs to this reader and stops with it.
        load.waiters = 1;
        yield* run(load);
        return yield* outcome(yield* Deferred.await(load.done));
      }).pipe(
        Effect.withSpan("sdk.tools.listing", {
          attributes: { "executor.app.id": state.app.id },
        }),
      ),
  };
};
export type Listings = ReturnType<typeof makeListings>;
