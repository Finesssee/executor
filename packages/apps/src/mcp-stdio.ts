/** Local MCP process helper. Requires a Node-compatible host and the optional MCP SDK peer. */
import { Effect } from "effect";
import type { ProcessConfig } from "./contracts/mcp.ts";
import { stdioToolsEffect } from "./implementation/mcp-stdio.ts";
import { protocolRouter, type OperationKinds } from "./implementation/protocol-operations.ts";
export { McpError, type McpToolContext, type ProcessConfig } from "./contracts/mcp.ts";

/** Discover an account's tools as a router; each discovery and call owns and closes its subprocess. */
export const stdioRouter = (
  config: ProcessConfig,
  signal?: AbortSignal,
  kinds: OperationKinds = {},
) =>
  Effect.runPromise(
    stdioToolsEffect(config).pipe(Effect.map((tools) => protocolRouter(tools, kinds))),
    signal === undefined ? {} : { signal },
  );
