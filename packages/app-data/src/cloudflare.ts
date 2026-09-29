/** Workerd edge: one supervisor per configured app; code changes preserve the isolated facet database. */
import { retireMethod, WorkerBundle, workerModules } from "./contracts/worker-bundle.ts";
import type {
  DurableObjectState,
  Fetcher,
  WorkerLoader,
  WorkerLoaderWorkerCode,
  WebSocket,
} from "@cloudflare/workers-types";
import { Clock, Deferred, Effect, Exit, Result, Schema, Semaphore } from "effect";
import { fingerprint } from "./implementation/cursor.ts";
import { AppDatabaseError } from "./contracts/database.ts";
import {
  CacheCommand,
  CacheError,
  CacheReply,
  changesCache,
} from "@executor-js/app-cache/contracts";
import { holdLeases } from "@executor-js/app-cache";
import { sqliteCache } from "@executor-js/app-cache/sqlite";

/** Executable bytes, supplied by the trusted build store rather than a browser request. */
export const FacetBundle = WorkerBundle;
/** The outer host has already authorized this exact app invocation. No credentials are persisted here. */
export const FacetInvocation = Schema.Struct({
  id: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  body: Schema.String,
  cacheNamespace: Schema.optionalKey(Schema.String),
  write: Schema.Boolean,
  headers: Schema.Record(Schema.String, Schema.String),
});
/**
 * The supervisor attaches the revision before releasing its serialized invocation, and whether
 * the invocation replaced or removed app cache data.
 */
export const FacetResult = Schema.Struct({
  value: Schema.Json,
  revision: Schema.Int,
  cacheChanged: Schema.optionalKey(Schema.Boolean),
});
const causes = new WeakMap<AppDatabaseError, unknown>();
/** Internal diagnostics, deliberately absent from the serialized error. */
export const facetFailureCause = (error: AppDatabaseError): unknown => causes.get(error);
const failed = (cause?: unknown) => {
  const error = new AppDatabaseError({ reason: "storage" });
  causes.set(error, cause);
  return error;
};

/**
 * The name each Worker Loader name currently loads under. The runtime keeps a rejected cold-start
 * callback under its name for the rest of the process and never runs another callback for that
 * name, so a cold start that fails, for instance because its caller was cancelled or the build
 * could not be read, retires the name. Later calls load the same code under a fresh one.
 */
const retired = new Map<string, string>();
let coldStartToken: string | undefined;
/** Marks this isolate's failed cold starts; authored code cannot produce it. */
const coldStartFailure = () => (coldStartToken ??= `Worker cold start ${crypto.randomUUID()}`);
const describe = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

/**
 * Get a Worker by name, loading its code only on a cold start. A failed load retires the name, so
 * the failure is not kept for later calls. Returns the name actually used.
 */
export const loadWorker = (
  loader: Pick<WorkerLoader, "get">,
  name: string,
  code: () => Promise<WorkerLoaderWorkerCode>,
) => {
  const current = retired.get(name) ?? name;
  const worker = loader.get(current, async () => {
    try {
      return await code();
    } catch (cause) {
      if ((retired.get(name) ?? name) === current)
        retired.set(name, `${name}~${crypto.randomUUID()}`);
      throw new Error(`${coldStartFailure()} failed: ${describe(cause)}`);
    }
  });
  return { worker, current };
};
/** The name the next call of this Worker loads under. */
export const workerName = (name: string) => retired.get(name) ?? name;

/** Loaded only if a name being unloaded is not resident, so the unload leaves nothing behind. */
const unloadedWorker = {
  mainModule: "retire.js",
  modules: {
    "retire.js": `import * as workers from "cloudflare:workers";
export default class extends workers.WorkerEntrypoint {
  ${retireMethod}
}`,
  },
  compatibilityDate: "2026-07-30",
};
const Retirable = Schema.declare(
  (value): value is { retire: () => Promise<unknown> } =>
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "retire" in value &&
    typeof value.retire === "function",
);
/** A Worker whose unload did not settle in time; later calls load its code under a fresh name. */
export const replaceWorker = (name: string) => {
  retired.set(name, `${name}~${crypto.randomUUID()}`);
};
/**
 * Unload an idle named Worker from this process. Resolves true once the runtime has dropped it,
 * so the next call of the name cold-starts, and false when the runtime cannot unload it. The
 * caller must not unload a Worker with calls in flight: the runtime does not stop them.
 */
export const unloadWorker = (loader: Pick<WorkerLoader, "get">, name: string) =>
  unloadLoaded(loader, workerName(name));
const unloadLoaded = async (loader: Pick<WorkerLoader, "get">, loaded: string) => {
  const worker = loader.get(loaded, async () => unloadedWorker);
  const entry = Schema.decodeUnknownSync(Retirable)(worker.getEntrypoint());
  try {
    return (await entry.retire()) !== false;
  } catch {
    // The aborted isolate never answers; its caller sees the abort as an internal error.
    return true;
  }
};
/**
 * Whether a call failed because this isolate's cold start of its Worker failed. No authored code
 * ran, and the name is already retired, so the call can be made again under the fresh name.
 */
export const failedColdStart = (cause: unknown) =>
  coldStartToken !== undefined && describe(cause).includes(coldStartToken);

/** Private per-call cancellation; the facet never receives the supervisor storage or namespace. */
const FacetEntrypoint = Schema.declare(
  (
    value,
  ): value is {
    invoke: (
      id: string,
      body: string,
      headers: Readonly<Record<string, string>>,
      elicitation: ((input: unknown) => Promise<unknown>) | null,
      workflows: ((input: unknown) => Promise<unknown>) | null,
      cache: ((input: unknown) => Promise<unknown>) | null,
    ) => Promise<unknown>;
    finish?: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
  } =>
    typeof value === "object" &&
    value !== null &&
    "invoke" in value &&
    typeof value.invoke === "function" &&
    "cancel" in value &&
    typeof value.cancel === "function",
);

/**
 * The facet Worker each data supervisor in this isolate loaded last, by supervisor ID. The runtime
 * evicts an idle supervisor and builds a new one for its next call, but keeps the Workers it
 * loaded, so this record lives in the isolate rather than in the supervisor. It lets a new
 * supervisor unload the facet its evicted predecessor left loaded.
 */
const loadedFacets = new Map<string, { readonly name: string; readonly loaded: string }>();

/** Use supervisor alarms: the pinned workerd cannot schedule alarms from a facet. */
export const makeFacetSupervisor = (
  state: DurableObjectState,
  loader: Pick<WorkerLoader, "get">,
  /**
   * Network the facet's global `fetch` uses. Cloudflare has no private network to reach, so it
   * passes nothing and relies on the compatibility flag. A local workerd host passes its own
   * outbound entrypoint, which applies a rule the flag cannot express there.
   */
  globalOutbound?: Fetcher,
  /**
   * Unload the Worker of a facet replaced for another account selection. A workerd host whose
   * process never unloads named Workers itself sets this; Cloudflare unloads them.
   */
  unloadReplacedFacets = false,
) =>
  Effect.gen(function* () {
    const execution = yield* Semaphore.make(1);
    const metadata = yield* Semaphore.make(1);
    const store = sqliteCache(state.storage);
    const cache = (namespace: string, command: unknown) =>
      store(namespace, command).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
        Effect.flatMap(Schema.encodeEffect(CacheReply)),
        Effect.orDie,
      );
    let writes = 0;
    const calls = new Map<
      string,
      { cancel: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
    >();
    /**
     * Unload the Worker of a facet this supervisor replaced. The runtime would otherwise keep it
     * for the life of the process, one per account selection ever used. A call that selects it
     * again waits for the unload and then loads it fresh.
     */
    const unloadReplaced = (replaced: { readonly name: string; readonly loaded: string }) =>
      Effect.promise(() => unloadLoaded(loader, replaced.loaded)).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.flatMap((settled) =>
          // The runtime may still hold the old Worker; a later call must not reach it.
          settled._tag === "None" && workerName(replaced.name) === replaced.loaded
            ? Effect.sync(() => replaceWorker(replaced.name))
            : Effect.void,
        ),
        Effect.catchCause(() => Effect.void),
      );
    let active: string | undefined;
    const acquire = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
    ) =>
      Effect.gen(function* () {
        const supervisor = state.id.toString();
        const name = `${supervisor}:${invocation.identity}`;
        const loaded = workerName(name);
        // Another execution context, or a retired name after a failed cold start, needs a new facet.
        if (active !== loaded) {
          state.facets.abort("data", "Execution context changed");
          active = loaded;
        }
        if (!unloadReplacedFacets) return yield* select(name, load);
        // Also covers a facet an evicted supervisor left loaded, which `active` never saw.
        const replaced = loadedFacets.get(supervisor);
        loadedFacets.set(supervisor, { name, loaded });
        if (replaced !== undefined && replaced.loaded !== loaded) yield* unloadReplaced(replaced);
        return yield* select(name, load);
      });
    const select = (name: string, load: () => Promise<typeof FacetBundle.Type>) =>
      Effect.try({
        try: () =>
          // An abort invalidates stubs. Reacquire on every serialized invocation.
          Schema.decodeUnknownSync(FacetEntrypoint)(
            state.facets.get("data", () => {
              const { worker } = loadWorker(loader, name, async () => {
                const bundle = Schema.decodeUnknownSync(Schema.toType(FacetBundle))(await load());
                return {
                  ...bundle,
                  modules: workerModules(bundle.modules),
                  compatibilityDate: "2026-07-30",
                  ...(globalOutbound === undefined
                    ? // Same-zone URLs must use their public Worker routes, not the underlying origin.
                      {
                        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
                      }
                    : // The flag would override this outbound and send fetch to the shared network.
                      {
                        compatibilityFlags: ["nodejs_compat"],
                        globalOutbound,
                      }),
                };
              });
              return { class: worker.getDurableObjectClass("ExecutorAppData") };
            }),
          ),
        catch: failed,
      });
    const revision = Effect.tryPromise({
      try: () => state.storage.get("revision"),
      catch: failed,
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(0)
          : Schema.decodeUnknownEffect(Schema.Int)(value).pipe(Effect.mapError(failed)),
      ),
    );
    const pending = Effect.tryPromise({
      try: () => state.storage.get("pending"),
      catch: failed,
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(false)
          : Schema.decodeUnknownEffect(Schema.Boolean)(value).pipe(Effect.mapError(failed)),
      ),
    );
    const arm = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.tryPromise({
        try: () => state.storage.setAlarm(now + 1_000),
        catch: failed,
      }),
    );
    const send = (socket: WebSocket, value: number) => {
      socket.send(JSON.stringify({ revision: value }));
      socket.serializeAttachment({ revision: value });
    };
    const notify = (value: number) =>
      Effect.try({
        try: () => {
          for (const socket of state.getWebSockets()) {
            const attachment = Schema.decodeUnknownSync(
              Schema.NullOr(Schema.Struct({ revision: Schema.Int })),
            )(socket.deserializeAttachment());
            if (attachment === null || attachment.revision < value) send(socket, value);
          }
        },
        catch: failed,
      });
    const begin = metadata.withPermits(1)(
      Effect.gen(function* () {
        yield* arm;
        yield* Effect.tryPromise({
          try: () => state.storage.put("pending", true),
          catch: failed,
        });
        writes++;
      }),
    );
    const finish = metadata.withPermits(1)(
      Effect.gen(function* () {
        writes--;
        const next = (yield* revision) + 1;
        yield* Effect.tryPromise({
          try: () => state.storage.put({ revision: next, pending: writes > 0 }),
          catch: failed,
        });
        yield* notify(next);
        if (writes === 0)
          yield* Effect.tryPromise({
            try: () => state.storage.deleteAlarm(),
            catch: failed,
          });
      }),
    );
    const recover = metadata.withPermits(1)(
      Effect.gen(function* () {
        if (writes > 0) return yield* arm;
        if (yield* pending) {
          const next = (yield* revision) + 1;
          yield* Effect.tryPromise({
            try: () => state.storage.put({ revision: next, pending: false }),
            catch: failed,
          });
        }
        yield* notify(yield* revision);
        yield* Effect.tryPromise({
          try: () => state.storage.deleteAlarm(),
          catch: failed,
        });
      }),
    );
    const invoke = (
      invocation: typeof FacetInvocation.Type,
      load: () => Promise<typeof FacetBundle.Type>,
      elicitation: ((input: unknown) => Promise<unknown>) | null,
      workflows: ((input: unknown) => Promise<unknown>) | null,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const entrypoint = yield* acquire(invocation, load);
          // Reads share the invocation lock with writes. Capture the revision before
          // execution so a later write cannot make an old query look current.
          const observedRevision = yield* revision;
          let cacheChanged = false;
          if (invocation.write)
            yield* Effect.acquireRelease(begin, () => finish.pipe(Effect.catch(() => Effect.void)));
          const run = Effect.gen(function* () {
            const namespace = invocation.cacheNamespace;
            // The invocation owns the leases it claims until it finishes, background refreshes included.
            const leases =
              namespace === undefined
                ? undefined
                : yield* holdLeases((command) => store(namespace, command));
            const closeLeases = () =>
              leases === undefined ? Promise.resolve() : Effect.runPromise(leases.close);
            const call = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const id = invocation.id;
                const result = Promise.resolve()
                  .then(() =>
                    entrypoint.invoke(
                      id,
                      invocation.body,
                      invocation.headers,
                      elicitation,
                      workflows,
                      leases === undefined
                        ? null
                        : (command) =>
                            Effect.runPromise(
                              Schema.decodeUnknownEffect(CacheCommand)(command).pipe(
                                Effect.mapError(() => new CacheError({ reason: "invalid" })),
                                Effect.flatMap(leases.transport),
                                Effect.tap(() =>
                                  Effect.sync(() => {
                                    if (changesCache(command)) cacheChanged = true;
                                  }),
                                ),
                                Effect.match({
                                  onSuccess: (value) => ({ ok: true as const, value }),
                                  onFailure: (error) => ({ ok: false as const, error }),
                                }),
                                Effect.flatMap(Schema.encodeEffect(CacheReply)),
                                Effect.orDie,
                              ),
                            ),
                    ),
                  )
                  .then(Result.succeed, Result.fail);
                return { id, result };
              }),
              ({ id, result }, exit) =>
                Effect.promise(async () => {
                  if (Exit.isFailure(exit)) {
                    // A facet transaction closes its input gate, so a cancel RPC cannot
                    // enter until it commits. Abort the isolated facet to roll it back.
                    state.facets.abort("data", "App invocation cancelled");
                  }
                  if (Exit.isSuccess(exit) && entrypoint.finish !== undefined) {
                    state.waitUntil(
                      entrypoint
                        .finish(id)
                        .catch(() => undefined)
                        .then(closeLeases),
                    );
                    return;
                  }
                  // Drain the invocation before the next caller acquires a fresh facet capability.
                  await Promise.allSettled([
                    Promise.resolve().then(() => entrypoint.cancel(id)),
                    result,
                  ]);
                  await closeLeases();
                }),
            );
            const result = yield* Effect.promise(() => call.result);
            if (Result.isFailure(result)) return yield* failed(result.failure);
            return yield* Schema.decodeUnknownEffect(Schema.Json)(result.success).pipe(
              Effect.mapError(failed),
            );
          });
          const value = yield* run;
          return {
            value,
            revision: observedRevision,
            ...(cacheChanged ? { cacheChanged: true } : {}),
          };
        }),
      ).pipe(
        // Storage operations already serialize inside the facet. Queue here so aborting
        // one invocation never kills another caller or leaves a stale facet capability.
        execution.withPermits(1),
      );
    return {
      cache,
      invoke: (
        input: typeof FacetInvocation.Type,
        load: () => Promise<typeof FacetBundle.Type>,
        elicitation: ((input: unknown) => Promise<unknown>) | null = null,
        workflows: ((input: unknown) => Promise<unknown>) | null = null,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const invocation = yield* Schema.decodeUnknownEffect(Schema.toType(FacetInvocation))(
              input,
            ).pipe(Effect.mapError(failed));
            const handle = {
              cancel: yield* Deferred.make<void>(),
              done: yield* Deferred.make<void>(),
            };
            if (calls.has(invocation.id)) return yield* failed();
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                calls.set(invocation.id, handle);
              }),
              () =>
                Effect.gen(function* () {
                  calls.delete(invocation.id);
                  yield* Deferred.succeed(handle.done, undefined);
                }),
            );
            return yield* Effect.raceFirst(
              invoke(invocation, load, elicitation, workflows),
              Deferred.await(handle.cancel).pipe(Effect.andThen(Effect.interrupt)),
            );
          }),
        ),
      cancel: (id: string) =>
        Effect.gen(function* () {
          const handle = calls.get(id);
          if (handle === undefined) return;
          yield* Deferred.succeed(handle.cancel, undefined);
          yield* Deferred.await(handle.done);
        }),
      initial: (socket: WebSocket) =>
        metadata.withPermits(1)(
          Effect.flatMap(revision, (current) =>
            Effect.try({ try: () => send(socket, current), catch: failed }),
          ),
        ),
      subscribe: (socket: WebSocket) =>
        metadata.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* revision;
            yield* Effect.try({
              try: () => {
                state.acceptWebSocket(socket);
                send(socket, current);
              },
              catch: failed,
            });
          }),
        ),
      recover,
    };
  });

/** A saved account as selected for one slot; only its stable identifier names a runtime. */
interface SelectedAccount {
  readonly id: string;
}
/**
 * A deployment and its account selection define one warm execution context. Credential values
 * and workflow runs are delivered with each invocation: a renewed token or another run must not
 * load another Worker, which the runtime would keep for its lifetime.
 */
export const facetIdentity = (
  build: string,
  accounts: Readonly<Record<string, SelectedAccount | ReadonlyArray<SelectedAccount>>>,
) =>
  fingerprint(
    crypto,
    JSON.stringify([
      build,
      Object.entries(accounts)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([slot, selected]) => [
          slot,
          "id" in selected ? selected.id : selected.map((account) => account.id),
        ]),
    ]),
  );
