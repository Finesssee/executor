/** Revisioned MCP metadata is persistent; selected executables remain invocation-owned. */
import { cacheKey } from "@executor-js/app-cache";
import { Effect, Schema } from "effect";
import type { DynamicRouter, RouterMeta } from "../contracts/router.ts";
import { McpError, McpServerHeader, McpToolMetadata, McpToolsOptions } from "../contracts/mcp.ts";
import { type JsonValue } from "../contracts/schema.ts";
import { catalogCache, type CatalogCacheOptions } from "./catalog-cache.ts";
import { mcpClientEffect } from "./mcp.ts";
import { adaptMcpTool } from "./mcp-tools.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";
import { routerDeclaration } from "./router.ts";

/** Metadata policy for HTTP/SSE sources. A missing cache keeps discovery invocation-local. */
export interface McpCatalogOptions extends McpToolsOptions, CatalogCacheOptions {}

/** Browsing metadata; schemas are read per tool. */
const McpToolSummary = McpToolMetadata.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
type McpToolSummary = typeof McpToolSummary.Type;

const invoke = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

/** Router metadata from a server's self-description. Author metadata on the router wins. */
const serverMeta = (server: McpServerHeader): RouterMeta => {
  const title = server.title ?? server.name;
  return {
    ...(title === undefined ? {} : { title }),
    ...(server.description === undefined ? {} : { description: server.description }),
    ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
    ...(server.icons === undefined ? {} : { icons: server.icons }),
  };
};

/** Construction opens no transport unless explicit revalidation is requested. */
export const mcpCatalog = (options: McpCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    // Header names are case-insensitive. Hash all request identity, including credentials,
    // before persistence; custom callers cannot accidentally share two authentication scopes.
    const parsed = yield* Schema.decodeUnknownEffect(McpToolsOptions)(options).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    const headers: Record<string, string> = {};
    new Headers(parsed.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const id = yield* cacheKey({ url: parsed.url, headers, accountId: parsed.accountId ?? null });
    const key: JsonValue = ["mcp-catalog-v3", id, "current"];
    const cache = options.cache;
    const changed = cache === undefined ? undefined : invoke(() => cache.invalidate(key));
    const client = yield* mcpClientEffect(options, changed);
    const catalog = yield* catalogCache({
      ...options,
      prefix: ["mcp-catalog-v3", id],
      schema: McpToolMetadata,
      summary: {
        schema: McpToolSummary,
        of: ({ inputSchema: _input, outputSchema: _output, _meta, ...summary }) => summary,
      },
      load: (context) =>
        (context === undefined
          ? client.list
          : mcpClientEffect(
              { ...parsed, signal: context.signal },
              invoke(() => context.cache.invalidate(key)),
            ).pipe(Effect.flatMap((source) => source.list))
        ).pipe(
          Effect.flatMap(({ tools, server }) =>
            Schema.encodeEffect(McpServerHeader)(server).pipe(
              Effect.map((header) => ({ tools, header })),
            ),
          ),
        ),
    });
    const kindOf = (tool: McpToolSummary) =>
      Object.hasOwn(kinds, tool.name)
        ? (kinds[tool.name] ?? "mutation")
        : tool.annotations?.readOnlyHint === true
          ? "query"
          : "mutation";
    const summarize = (tool: McpToolSummary) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      readOnly: kindOf(tool) === "query",
      ...(tool.title === undefined ? {} : { title: tool.title }),
      annotations: { ...tool.annotations, readOnlyHint: kindOf(tool) === "query" },
    });
    const describe = (tool: McpToolMetadata) => ({
      ...summarize(tool),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
    });
    const router: DynamicRouter = {
      kind: "dynamic",
      meta: () =>
        catalog.header().pipe(
          Effect.flatMap((header) =>
            header === undefined
              ? Effect.succeed({})
              : Schema.decodeUnknownEffect(McpServerHeader)(header),
          ),
          Effect.map(serverMeta),
        ),
      list: () => catalog.list().pipe(Effect.map((tools) => tools.map(describe))),
      summaries: () => catalog.summaries().pipe(Effect.map((tools) => tools.map(summarize))),
      describe: (name) =>
        catalog
          .resolve(name)
          .pipe(Effect.map((tool) => (tool === undefined ? undefined : describe(tool)))),
      resolve: (name) =>
        Effect.gen(function* () {
          const tool = yield* catalog.resolve(name);
          if (tool === undefined) return undefined;
          const adapted = yield* adaptMcpTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.selected);
        }),
    };
    return routerDeclaration(router);
  });
