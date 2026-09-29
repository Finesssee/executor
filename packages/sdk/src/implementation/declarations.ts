/** Stale-while-revalidate reads of evaluated app declarations (skills, workflows, webhooks). */
import { Clock, Deferred, Effect, Encoding, Option, Schema, type Crypto } from "effect";
import {
  declarationFreshness,
  declarationLimits,
  type BackgroundWork,
  type DeclarationCache,
  type DeclarationLimits,
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
  return {
    key,
    authorize,
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
          return value;
        });
        const kept = yield* options.cache.get(id);
        const cached = kept?.kind === "json" ? kept : undefined;
        const age = cached === undefined ? Infinity : (yield* Clock.currentTimeMillis) - cached.at;
        if (cached === undefined || age >= declarationFreshness.maxStaleMillis) {
          yield* Effect.annotateCurrentSpan("executor.declarations.cache", "miss");
          return yield* load;
        }
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
      }).pipe(
        Effect.withSpan("sdk.declarations.read", {
          attributes: { "executor.declarations.command": command },
        }),
      ),
  };
};
export type Declarations = ReturnType<typeof makeDeclarations>;
