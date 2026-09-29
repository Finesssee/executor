import { Predicate, Redacted, Schema } from "effect";
import { AppDatabaseError } from "@executor-js/app-data/contracts";
import { AppStorageError, AppStorageUnavailable } from "../contracts/storage.ts";
import { OpenapiError } from "../contracts/openapi.ts";
import type { ResolvedAccounts } from "../contracts/host.ts";
import { maxFailureMessageLength } from "../contracts/failure.ts";

/** Fields of `FailureDetail` as constructor input. */
export interface FailureDetail {
  readonly source?: "app" | "storage" | "service";
  readonly errorName?: string;
  readonly code?: string;
  readonly message?: string;
}

const storageMessages = {
  schema: "The app's database schema is invalid.",
  schema_changed: "The app's database schema changed during this operation. Retry it.",
  table: "The operation used a table the app's database schema does not declare.",
  index: "The operation used an index the table does not declare, or used it incorrectly.",
  range: "The index range is invalid for the declared index.",
  value: "A value does not match the table's declared field schema.",
  readonly: "Queries cannot write. Move writes into a mutation.",
  cursor: "The pagination cursor is invalid or belongs to a different query.",
  limit: "The operation exceeded a per-invocation app data limit.",
  closed: "The database session closed before this operation finished.",
  storage: "App storage failed to complete the operation.",
  replay: "A workflow step replayed with different input than its first run.",
} satisfies Record<AppDatabaseError["reason"], string>;

/** Account field values of at least this length are replaced wherever a message contains them. */
const minimumSecretLength = 6;

const secretValues = (value: unknown, found: Set<string>): Set<string> => {
  if (typeof value === "string") {
    if (value.length >= minimumSecretLength) found.add(value);
  } else if (Array.isArray(value)) for (const item of value) secretValues(item, found);
  else if (Predicate.isObject(value))
    for (const item of Object.values(value)) secretValues(item, found);
  return found;
};

/**
 * Every credential field value of a slot-to-account record, longest first. Accepts both resolved
 * host accounts and bound author accounts; each account keeps its credential values in `fields`.
 */
export const accountFieldSecrets = (accounts: unknown) => {
  const found = new Set<string>();
  if (Predicate.isObject(accounts))
    for (const slot of Object.values(accounts))
      for (const account of Array.isArray(slot) ? slot : [slot])
        if (Predicate.hasProperty(account, "fields")) secretValues(account.fields, found);
  return [...found].sort((a, b) => b.length - a.length);
};

/** Every credential field value of an invocation's selected accounts. */
export const accountSecrets = (accounts: Redacted.Redacted<ResolvedAccounts>) =>
  accountFieldSecrets(Redacted.value(accounts));

/** Replace account secrets and bound the message for the runtime boundary. */
export const boundFailureMessage = (message: string, secrets: readonly string[]) => {
  let redacted = message;
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted.length <= maxFailureMessageLength
    ? redacted
    : `${redacted.slice(0, maxFailureMessageLength - 1)}…`;
};

const errorName = (error: Error) => (error.name.length > 0 ? error.name : "Error").slice(0, 128);

const ownMessage = (error: Error) => {
  const cause = error.cause;
  const suffix =
    cause instanceof Error && cause.message.length > 0
      ? ` (caused by ${errorName(cause)}: ${cause.message})`
      : "";
  return error.message.length > 0 ? `${error.message}${suffix}` : undefined;
};

/** `Name: message` for any thrown value, before redaction. */
export const describeFailure = (error: unknown) =>
  error instanceof Error
    ? `${errorName(error)}: ${ownMessage(error) ?? "(no message)"}`
    : typeof error === "string"
      ? error
      : `A non-Error ${error === null ? "null" : typeof error} value was thrown`;

/**
 * Describe what an operation raised for the app's own caller. App data failures keep their
 * reason as a code; any other thrown value is the app's own error. Account secrets are replaced.
 */
export const failureDetail = (error: unknown, secrets: readonly string[]): FailureDetail => {
  if (Schema.is(AppDatabaseError)(error))
    return {
      source: "storage",
      errorName: "AppDatabaseError",
      code: error.reason,
      message: boundFailureMessage(ownMessage(error) ?? storageMessages[error.reason], secrets),
    };
  if (Schema.is(AppStorageUnavailable)(error))
    return {
      source: "storage",
      errorName: "AppStorageUnavailable",
      message: "App storage is not available on this host.",
    };
  if (Schema.is(AppStorageError)(error))
    return {
      source: "storage",
      errorName: "AppStorageError",
      message: "App storage failed to complete the operation.",
    };
  if (Schema.is(OpenapiError)(error))
    return {
      source: "service",
      errorName: "OpenapiError",
      code: error.reason,
      message:
        error.reason === "request"
          ? error.status === undefined
            ? "The API request failed before a response arrived."
            : `The API responded with HTTP ${error.status}, which its OpenAPI document does not declare as an error with a message.`
          : error.reason === "invalid_input"
            ? "The input could not be encoded as a request for this API operation."
            : "The API's OpenAPI definition for this operation is invalid.",
    };
  if (error instanceof Error)
    return {
      source: "app",
      errorName: errorName(error),
      message: boundFailureMessage(
        ownMessage(error) ?? `${errorName(error)} was thrown without a message.`,
        secrets,
      ),
    };
  if (typeof error === "string")
    return { source: "app", errorName: "string", message: boundFailureMessage(error, secrets) };
  return {
    source: "app",
    errorName: typeof error,
    message: `A non-Error ${error === null ? "null" : typeof error} value was thrown.`,
  };
};
