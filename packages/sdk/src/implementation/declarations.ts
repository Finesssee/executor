/** Stale-while-revalidate reads of evaluated app declarations (skills, workflows, webhooks). */
import { Clock, Deferred, Effect, Encoding, Fiber, Option, Schema, type Crypto } from "effect";
import {
  declarationFreshness,
  declarationLimits,
  durableHeadStartMillis,
  type BackgroundWork,
  type DeclarationCache,
  type DeclarationLimits,
  type DurableDeclarations,
  type DurableEntry,
  type KeptEntry,
  type PendingLoad,
} from "../contracts/declarations.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { CurrentProfile } from "../contracts/profiles.ts";
import { StorageError } from "../contracts/shared.ts";
import type { makeOAuth } from "./oauth.ts";
import { resolve, type InvocationSnapshot } from "./tools.ts";

/** One store per process or isolate. Least recently used entries leave first. */
export const makeDeclarationCache = (
  limits: DeclarationLimits = declarationLimits,
): DeclarationCache => {
  const entries = new Map<string, KeptEntry>();
  const loads = new Map<string, PendingLoad>();
  /** When each app's cached upstream data last changed. */
  const changes = new Map<string, number>();
  let bytes = 0;
  const size = (entry: KeptEntry) => (entry.kind === "json" ? entry.json.length * 2 : entry.bytes);
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    bytes -= size(entry);
  };
  return {
    get: (key) =>
      Effect.sync(() => {
        const entry = entries.get(key);
        if (entry === undefined) return undefined;
        entries.delete(key);
        entries.set(key, entry);
        return entry;
      }),
    set: (key, entry) =>
      Effect.sync(() => {
        remove(key);
        // Started no later than the app's cached data changed: it may reflect the replaced data.
        if (entry.at <= (changes.get(entry.app) ?? -Infinity)) return;
        if (size(entry) > limits.entryBytes) return;
        entries.set(key, entry);
        bytes += size(entry);
        for (const oldest of entries.keys()) {
          if (entries.size <= limits.entries && bytes <= limits.bytes) break;
          remove(oldest);
        }
      }),
    pending: (key) => loads.get(key),
    begin: (key, load) => {
      loads.set(key, load);
    },
    end: (key, load) => {
      if (loads.get(key) === load) loads.delete(key);
    },
    changed: (app, at) => {
      changes.set(app, Math.max(at, changes.get(app) ?? at));
      for (const [key, entry] of entries) if (entry.app === app && entry.at <= at) remove(key);
    },
    outdated: (app, at) => at <= (changes.get(app) ?? -Infinity),
  };
};

const JsonText = Schema.fromJsonString(Schema.Unknown);

/**
 * Evaluated declarations depend on the build, the profile revision, the selected accounts and
 * their credential generations. Token renewal keeps a result; reconnecting replaces it. Every read reruns the invocation snapshot; a kept result is served
 * only after the same lifecycle checks that precede credential release in an evaluation.
 */
export const makeDeclarations = (options: {
  readonly cache: DeclarationCache;
  readonly durable: DurableDeclarations | undefined;
  readonly background: BackgroundWork | undefined;
  readonly resolveAccount: ReturnType<typeof makeOAuth>["resolve"];
  readonly accountUsable: ReturnType<typeof makeOAuth>["usable"];
  readonly crypto: Crypto.Crypto;
  readonly lifecycle: ResourceLifecycle | undefined;
}) => {
  const digest = (bytes: Uint8Array) =>
    options.crypto.digest("SHA-256", bytes).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(() => new StorageError()),
    );
  const key = (command: string, state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const selections = state.selections.map(({ slot, accounts }) => [
        slot,
        accounts.map((account) => [
          account.id,
          account.provider,
          account.method,
          account.credentialGeneration,
        ]),
      ]);
      return yield* digest(
        new TextEncoder().encode(
          JSON.stringify([
            command,
            state.app.owner,
            state.app.id,
            state.deployment.id,
            state.deployment.build,
            state.profile === undefined
              ? null
              : [state.profile.id, state.profile.revision, state.profile.subject],
            selections,
          ]),
        ),
      );
    });
  /**
   * The checks that precede credential release in a live evaluation, and the grant state that
   * would stop it: a kept result is never served for an account a live read would refuse, such
   * as an OAuth grant that needs reconnecting.
   */
  const authorize = (state: InvocationSnapshot) =>
    Effect.gen(function* () {
      const lifecycle = options.lifecycle;
      if (state.profile !== undefined && lifecycle?.profileResolving)
        yield* lifecycle.profileResolving(state.profile);
      yield* Effect.forEach(
        state.selections.flatMap(({ required, accounts }) =>
          accounts.map((account) => ({ account, provider: required.definition })),
        ),
        ({ account, provider }) =>
          Effect.all(
            [
              lifecycle === undefined ? Effect.void : lifecycle.accountResolving(account),
              options.accountUsable(account, provider),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.provideService(CurrentProfile, state.profile));
  /** A result another process or isolate kept, if the host keeps results beyond this one. */
  const recall = (app: string, id: string) =>
    options.durable === undefined ? Effect.succeed(undefined) : options.durable.get(app, id);
  /**
   * Keep a result beyond this process, after its readers have it when the host allows. `entry`
   * runs only when the host keeps results beyond this process.
   */
  const persist = <E>(
    app: string,
    id: string,
    entry: Effect.Effect<DurableEntry & { readonly until: number }, E>,
  ) =>
    Effect.gen(function* () {
      const durable = options.durable;
      if (durable === undefined) return;
      const write = entry.pipe(
        Effect.flatMap((kept) => durable.set(app, id, kept)),
        Effect.catchCause(() => Effect.logWarning("Durable declaration write failed")),
      );
      if (options.background === undefined) return yield* write;
      yield* options.background(write);
    });
  return {
    key,
    authorize,
    recall,
    persist,
    /**
     * Read `command` for this invocation state. `retain` keeps only results determined by these
     * inputs; a result that reflects a live publisher is never reused. `current` rejects a cached
     * value the caller knows is outdated, such as a skill revision it has already seen replaced.
     * `live` evaluates without reading or writing kept results, for callers that act on the
     * result, such as reconciling upstream webhook registrations.
     */
    read: <E>(
      command: string,
      state: InvocationSnapshot,
      evaluate: (context: Effect.Success<ReturnType<typeof resolve>>) => Effect.Effect<unknown, E>,
      policy: {
        readonly retain?: (value: unknown) => boolean;
        readonly current?: (value: unknown) => Effect.Effect<boolean>;
        readonly live?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        // Inputs are read no earlier than this; age counts from here, not from when an
        // evaluation, possibly a background one, finished.
        const started = yield* Clock.currentTimeMillis;
        const evaluated = resolve(state, options.resolveAccount, options.lifecycle).pipe(
          Effect.flatMap(evaluate),
        );
        if (policy.live === true) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "live");
          return yield* evaluated;
        }
        const id = yield* key(command, state);
        const load = Effect.gen(function* () {
          const value = yield* evaluated;
          if (policy.retain !== undefined && !policy.retain(value)) return value;
          const json = yield* Schema.encodeEffect(JsonText)(value).pipe(
            Effect.mapError(() => new StorageError()),
          );
          yield* options.cache.set(id, { kind: "json", app: state.app.id, at: started, json });
          yield* persist(
            state.app.id,
            id,
            Effect.succeed({
              at: started,
              json,
              until: started + declarationFreshness.maxStaleMillis,
            }),
          );
          return value;
        });
        const current = (entry: KeptEntry | undefined, now: number) =>
          entry?.kind === "json" && now - entry.at < declarationFreshness.maxStaleMillis
            ? entry
            : undefined;
        const miss = Effect.annotateCurrentSpan("executor.declarations.cache", "miss").pipe(
          Effect.andThen(load),
        );
        /** Serve a kept result by its age, the caller's `current` policy and access checks. */
        const serve = (cached: KeptEntry & { readonly kind: "json" }) =>
          Effect.gen(function* () {
            const age = (yield* Clock.currentTimeMillis) - cached.at;
            if (age >= declarationFreshness.maxStaleMillis) return yield* miss;
            // A kept value this process cannot decode is replaced, never surfaced as a failure.
            const decoded = yield* Schema.decodeEffect(JsonText)(cached.json).pipe(Effect.option);
            if (Option.isNone(decoded)) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
              return yield* load;
            }
            const value = decoded.value;
            if (policy.current !== undefined && !(yield* policy.current(value))) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "outdated");
              return yield* load;
            }
            const stale = age >= declarationFreshness.freshMillis;
            const background = options.background;
            if (stale && background === undefined) {
              yield* Effect.annotateCurrentSpan("executor.declarations.cache", "expired");
              return yield* load;
            }
            yield* authorize(state);
            yield* Effect.annotateCurrentSpan({
              "executor.declarations.cache": stale ? "stale" : "hit",
              "executor.declarations.age_ms": age,
            });
            if (stale && background !== undefined)
              // Registering and handing over the refresh happen together, so an interrupted request
              // cannot leave a registration that no refresh will end.
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  if (options.cache.pending(id) !== undefined) return;
                  const refresh: PendingLoad = {
                    started: yield* Clock.currentTimeMillis,
                    waiters: 0,
                    overdue: false,
                    unwatched: Deferred.makeUnsafe(),
                    done: Deferred.makeUnsafe(),
                  };
                  options.cache.begin(id, refresh);
                  const accepted = yield* background(
                    load.pipe(
                      Effect.timeout(declarationFreshness.refreshMillis),
                      Effect.catchCause(() => Effect.logWarning("Declaration refresh failed")),
                      Effect.asVoid,
                      Effect.onExit(() =>
                        Effect.suspend(() => {
                          options.cache.end(id, refresh);
                          return Deferred.succeed(refresh.done, undefined);
                        }),
                      ),
                      Effect.withSpan("sdk.declarations.refresh"),
                    ),
                  );
                  if (!accepted) options.cache.end(id, refresh);
                }),
              );
            return value;
          });
        const kept = current(yield* options.cache.get(id), yield* Clock.currentTimeMillis);
        if (kept?.kind === "json") return yield* serve(kept);
        if (options.durable === undefined) return yield* miss;
        // Another isolate's result, unless an invalidation seen here replaced it. It is kept here
        // too when it fits.
        const recalling = yield* Effect.forkChild(
          recall(state.app.id, id).pipe(
            Effect.flatMap((found) =>
              Effect.gen(function* () {
                if (found === undefined || options.cache.outdated(state.app.id, found.at))
                  return undefined;
                const entry = { kind: "json" as const, app: state.app.id, ...found };
                yield* options.cache.set(id, entry);
                return current(entry, yield* Clock.currentTimeMillis);
              }),
            ),
          ),
        );
        const recalled = (found: KeptEntry | undefined) =>
          found?.kind === "json"
            ? Effect.annotateCurrentSpan("executor.declarations.source", "durable").pipe(
                Effect.andThen(serve(found)),
              )
            : undefined;
        const early = yield* Fiber.join(recalling).pipe(
          Effect.timeoutOption(durableHeadStartMillis),
        );
        if (Option.isSome(early)) return yield* recalled(early.value) ?? miss;
        // A slow supervisor, often one waking up, would delay every miss: evaluate beside the
        // read and answer with whichever settles first. A result the read finds still wins.
        return yield* Effect.raceFirst(
          miss,
          Fiber.join(recalling).pipe(Effect.flatMap((found) => recalled(found) ?? Effect.never)),
        );
      }).pipe(
        Effect.withSpan("sdk.declarations.read", {
          attributes: { "executor.declarations.command": command },
        }),
      ),
  };
};
export type Declarations = ReturnType<typeof makeDeclarations>;
