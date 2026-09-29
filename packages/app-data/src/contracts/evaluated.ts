/** Protocol of the store of evaluated results an app's supervisor keeps beside its app cache. */
import { Schema } from "effect";

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Body = Schema.declare((value): value is Uint8Array => value instanceof Uint8Array);

/** Bounds of one app's store. Bodies are compressed by the caller before they are written. */
export const evaluatedLimits = {
  /** SQLite on Durable Objects stores at most 2 MB in one value. */
  partBytes: 1_000_000,
  entryBytes: 8_000_000,
  totalBytes: 64_000_000,
} as const;

/**
 * `at` is when the read that produced the result began; `until` is when the store may drop it.
 * A write whose evaluation began no later than the app's last cache invalidation is refused.
 */
export const EvaluatedCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), key: Key }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    key: Key,
    at: Time,
    until: Time,
    body: Body,
  }),
]);
export type EvaluatedCommand = typeof EvaluatedCommand.Type;

/** A read's reply: the kept body, or null when there is none evaluated since the last invalidation. */
export const EvaluatedEntry = Schema.NullOr(Schema.Struct({ at: Time, body: Body }));
export type EvaluatedEntry = typeof EvaluatedEntry.Type;
