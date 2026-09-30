import { Effect } from "effect";

import { isToolResult, ToolAddress, type Executor, type Tool } from "@executor-js/sdk/core";

import { ExecutionToolError } from "./errors";
import { defaultToolDiscoveryProvider, type ToolDiscoveryProvider } from "./tool-invoker";

const ROUTER_INTEGRATION = "typesafe-jev";
const ROUTER_OPERATION = "systemoneV1SystemonePost";
// A TypeSafe Choice supports 255 options; one is reserved for none_of_these.
const MAX_CANDIDATES = 254;

const routerFailure = (message: string, cause?: unknown) =>
  new ExecutionToolError({ message: `Jev tool routing failed: ${message}`, cause });

const readChoice = (value: unknown): string | null => {
  if (!isToolResult(value) || !value.ok) return null;
  const payload = value.data;
  if (payload === null || typeof payload !== "object" || !("answers" in payload)) return null;
  const answers = payload.answers;
  if (answers === null || typeof answers !== "object" || !("route" in answers)) return null;
  const route = answers.route;
  if (route === null || typeof route !== "object" || !("choice" in route)) return null;
  return typeof route.choice === "string" ? route.choice : null;
};

const choose = (
  executor: Executor,
  router: Tool,
  intent: string,
  instructions: string,
  criteria: Record<string, string>,
) =>
  Effect.gen(function* () {
    const response = yield* executor
      .execute(ToolAddress.make(String(router.address)), {
        body: {
          model: "jev-latest",
          state: { intent },
          questions: { route: { type: "choice", instructions, criteria } },
        },
      })
      .pipe(Effect.mapError((cause) => routerFailure("System One request failed", cause)));
    const choice = readChoice(response);
    if (choice === null || !Object.hasOwn(criteria, choice)) {
      return yield* routerFailure("System One returned no valid candidate");
    }
    return choice;
  });

const pathOf = (tool: Tool): string => String(tool.address).replace(/^tools\./, "");

/**
 * Route a non-empty search through Jev. The complete integration catalog is
 * the first Choice, and every tool in the selected integration is the second
 * Choice. The search returns that single tool. Empty-query namespace
 * enumeration keeps its existing behavior.
 */
export const createJevToolDiscoveryProvider = (
  base: ToolDiscoveryProvider = defaultToolDiscoveryProvider,
): ToolDiscoveryProvider => ({
  searchTools: (input) =>
    Effect.gen(function* () {
      if (!input.query.trim() || input.namespace === ROUTER_INTEGRATION) {
        return yield* base.searchTools(input);
      }
      if (input.offset > 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }

      const tools = yield* input.executor.tools
        .list({ includeAnnotations: false })
        .pipe(Effect.mapError((cause) => routerFailure("could not list the tool catalog", cause)));
      const router = tools.find(
        (tool) =>
          String(tool.integration) === ROUTER_INTEGRATION &&
          String(tool.name).split(".").at(-1) === ROUTER_OPERATION,
      );
      if (!router) {
        return yield* routerFailure("the typesafe-jev System One tool is unavailable");
      }

      const eligible = tools.filter((tool) => String(tool.integration) !== ROUTER_INTEGRATION);
      const namespaces = input.namespace
        ? [input.namespace]
        : [...new Set(eligible.map((tool) => String(tool.integration)))].sort();
      if (namespaces.length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      if (namespaces.length > MAX_CANDIDATES) {
        return yield* routerFailure("too many integrations for a bounded Choice");
      }

      let namespace: string | undefined = namespaces[0];
      if (namespaces.length > 1) {
        const criteria: Record<string, string> = Object.fromEntries(
          namespaces.map((name, index) => {
            const names = eligible
              .filter((tool) => String(tool.integration) === name)
              .slice(0, 40)
              .map((tool) => String(tool.name));
            return [
              `integration_${index}`,
              `${name}. Available tools include: ${names.join(", ")}`,
            ];
          }),
        );
        criteria.none_of_these = "No listed integration can fulfill the intent.";
        const choice = yield* choose(
          input.executor,
          router,
          input.query,
          "Which connected integration should handle the intent? Choose none_of_these when none fits.",
          criteria,
        );
        if (choice === "none_of_these") {
          return { items: [], total: 0, hasMore: false, nextOffset: null };
        }
        const index = choice.match(/^integration_(\d+)$/)?.[1];
        namespace = index === undefined ? undefined : namespaces[Number(index)];
      }
      if (!namespace) return yield* routerFailure("integration choice was outside the catalog");

      const candidates = eligible.filter((tool) => String(tool.integration) === namespace);
      if (candidates.length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      if (candidates.length > MAX_CANDIDATES) {
        return yield* routerFailure(`integration ${namespace} has too many tools for a Choice`);
      }

      let selected: Tool | undefined = candidates[0];
      if (candidates.length > 1) {
        const criteria: Record<string, string> = Object.fromEntries(
          candidates.map((tool, index) => [
            `tool_${index}`,
            `${tool.name}. ${tool.description ?? "No description available."}`,
          ]),
        );
        criteria.none_of_these = "No listed tool can carry out the intent.";
        const choice = yield* choose(
          input.executor,
          router,
          input.query,
          `Which tool in ${namespace} best performs the intent? Choose none_of_these if none fits. Do not infer capabilities not in the descriptions.`,
          criteria,
        );
        if (choice === "none_of_these") {
          return { items: [], total: 0, hasMore: false, nextOffset: null };
        }
        const index = choice.match(/^tool_(\d+)$/)?.[1];
        selected = index === undefined ? undefined : candidates[Number(index)];
      }
      if (!selected) return yield* routerFailure("tool choice was outside the catalog");

      const chosen = {
        path: pathOf(selected),
        name: String(selected.name),
        integration: String(selected.integration),
        ...(selected.description === undefined ? {} : { description: selected.description }),
        score: Number.MAX_SAFE_INTEGER,
      };
      return { items: [chosen], total: 1, hasMore: false, nextOffset: null };
    }),
});
