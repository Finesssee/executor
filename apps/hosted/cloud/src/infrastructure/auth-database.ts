/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { openPostgresPool } from "alchemy/SQL/PostgresDriver";
import { Context, Effect, Layer, Option, Schema, Tracer } from "effect";
import { Kysely, PostgresDialect, type PostgresPool, type QueryId } from "kysely";
import type { Pool } from "pg";
import { cloudDatabaseConnection } from "./database.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
});
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {}

/**
 * The invocation whose Promise work is calling Better Auth: its own pool, the
 * background tasks it must keep alive, and the context and span its SQL reports to.
 */
interface AuthInvocation {
  readonly pool: Pool;
  readonly pending: Array<Promise<unknown>>;
  readonly context: Context.Context<never>;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

/**
 * Better Auth and its Kysely instance live for the isolate, but workerd sockets
 * belong to one invocation. Every call into Better Auth runs inside
 * {@link AuthDatabaseService.bind}, and each connection comes from that caller's pool.
 */
const invocation = new AsyncLocalStorage<AuthInvocation>();

const current = () => {
  const store = invocation.getStore();
  // A query outside a bound call has no invocation that may own its socket.
  if (store === undefined) throw new Error("Auth database used outside a bound invocation");
  return store;
};

/**
 * Hands Kysely the calling invocation's pool. Closing is a no-op: each
 * invocation's pool closes with its event scope. Without a `Client` constructor,
 * Kysely cancels an aborted query over the same invocation's pool; Better Auth
 * does not abort queries.
 */
const invocationPool: PostgresPool = {
  connect: () => Promise.resolve().then(() => current().pool.connect()),
  end: () => Promise.resolve(),
  get options() {
    return current().pool.options;
  },
};

/**
 * Better Auth's Kysely instance. Each query records an `auth.sql.timing` span
 * under the span that issued it, or under its invocation when no span was bound.
 */
const timedAuthDatabase = () => {
  const started = new WeakMap<QueryId, number>();
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: invocationPool }),
    plugins: [
      {
        transformQuery: ({ queryId, node }) => {
          started.set(queryId, Date.now());
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      },
    ],
    log: (event) => {
      const start = started.get(event.query.queryId);
      started.delete(event.query.queryId);
      const { context, parent } = current();
      return Effect.runPromiseWith(
        Option.match(parent, {
          onNone: () => context,
          onSome: (span) => Context.add(context, Tracer.ParentSpan, span),
        }),
      )(
        (event.level === "error"
          ? Effect.fail(
              new AuthDatabaseFailed({
                code: Option.match(Schema.decodeUnknownOption(DriverCode)(event.error), {
                  onNone: () => "UnknownDriverError",
                  onSome: ({ code }) => code,
                }),
              }),
            )
          : Effect.void
        ).pipe(
          Effect.withSpan("auth.sql.timing", {
            attributes: {
              "db.query.kind": event.query.query.kind,
              "db.query.duration_ms": event.queryDurationMillis,
              "db.query.success": event.level === "query",
              "db.query.parameter_count": event.query.parameters.length,
              "db.query.clock": "cloudflare-io",
              ...(start === undefined
                ? {}
                : { "db.query.compile_to_result_ms": Date.now() - start }),
            },
          }),
          Effect.withErrorReporting,
          Effect.ignore,
        ),
      );
    },
  });
};

export interface AuthDatabaseService {
  /** Better Auth's `database` option. It holds no connection of its own. */
  readonly options: {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    // SSO account resolution and membership provisioning require real
    // transactions; the Kysely adapter otherwise runs callbacks without one.
    readonly transaction: true;
  };
  /** Better Auth's background tasks join the invocation that started them. */
  readonly background: (task: Promise<unknown>) => void;
  /**
   * Bind Promise work to this invocation's pool and the calling span, so its SQL
   * uses this event's socket and its timing spans become children of the caller.
   */
  readonly bind: Effect.Effect<<A>(run: () => A) => A, never, RuntimeContext>;
}

export class AuthDatabase extends Context.Service<AuthDatabase, AuthDatabaseService>()(
  "executor/cloud/AuthDatabase",
) {}

/** An object whose methods run as work bound by {@link AuthDatabaseService.bind}. */
export const boundAuthAdapter = <A extends object>(adapter: A, bind: <B>(run: () => B) => B): A =>
  new Proxy(adapter, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => bind(() => Reflect.apply(value, target, args))
        : value;
    },
  });

/** One Kysely instance per isolate; each invocation opens and closes its own pool. */
export const cloudAuthDatabase = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    const resources = yield* makeExecutionMemo(
      Effect.gen(function* () {
        // Alchemy's request-owned pg pool, closed when the event settles.
        const url = yield* connection.connectionString;
        const pool = yield* openPostgresPool(Effect.succeed(url));
        const pending: Array<Promise<unknown>> = [];
        // Added after the pool, so it runs first: background SQL still has its socket.
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.allSettled(pending)));
        return { pool, pending };
      }),
    );
    return AuthDatabase.of({
      options: { db: timedAuthDatabase(), type: "postgres", transaction: true },
      background: (task) => current().pending.push(task),
      bind: Effect.gen(function* () {
        const { pool, pending } = yield* resources;
        const parent = yield* Effect.option(Effect.currentParentSpan);
        // This trusted host callback needs the complete invocation context.
        const context = yield* Effect.context<never>();
        return <A>(run: () => A) => invocation.run({ pool, pending, context, parent }, run);
      }),
    });
  }),
);
