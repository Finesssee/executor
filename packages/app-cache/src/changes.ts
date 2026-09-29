/**
 * Host-side reading of cache commands. Kept apart from the protocol contracts, which the published
 * `apps` framework bundles, so hosts can change how they reuse evaluated results without a release.
 */
import { Option, Schema } from "effect";
import { CacheCommand } from "./contracts/cache.ts";

/**
 * Whether a command asked for retained data to be replaced now: an invalidation, such as the one
 * that follows an MCP server's `notifications/tools/list_changed`, or the claim that starts an
 * explicit refresh, which then publishes before its caller continues. Hosts report these so
 * results evaluated from the earlier data are not reused. A routine refresh or a direct write
 * replaces data a kept result may still reflect until its next stale-while-revalidate refresh,
 * so it is not reported.
 */
export const discardsEvaluated = (command: unknown) => {
  const operation = Schema.decodeUnknownOption(CacheCommand)(command);
  if (Option.isNone(operation)) return false;
  const value = operation.value;
  return value.operation === "invalidate" || (value.operation === "acquire" && value.refresh);
};
