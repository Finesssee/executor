/** Product permission policies, independent of credentials, OAuth and approval delivery. */
import { AppId, ProfileId, ToolName } from "@executor-js/sdk/core";
import { Match, Schema } from "effect";

/** Product operations; roles still bound the authority granted by any of these actions. */
export const Action = Schema.Literals(["discover", "read", "run", "manage", "data"]);
export type Action = typeof Action.Type;
/**
 * Which of an app's tools are permitted. `all` and `readOnly` are rules that include
 * future tools; `readOnly` requires the live catalog's `readOnly === true`. Selected
 * names are exact and never expand.
 */
export const ToolScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("readOnly") }),
  Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(ToolName) }),
]);
export type ToolScope = typeof ToolScope.Type;
/** How an app may run: the account-free app itself, or one of the caller's saved profiles. */
export const RunTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("app") }),
  Schema.Struct({ kind: Schema.Literal("profile"), id: ProfileId }),
]);
export type RunTarget = typeof RunTarget.Type;
/**
 * Explicit app-wide permission includes future tools; selected names never do.
 * Omitted targets leave the caller's own profiles unrestricted; listed targets are exact.
 */
export const AppPermission = Schema.Struct({
  app: AppId,
  tools: ToolScope,
  targets: Schema.optionalKey(Schema.Array(RunTarget)),
});
export type AppPermission = typeof AppPermission.Type;
/** The same app and tool selection is used by all product transports. */
export const ToolSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("tools"), apps: Schema.Array(AppPermission) }),
]);
export type ToolSelection = typeof ToolSelection.Type;
/** Full user authority and explicit delegated actions are distinct; empty selections deny access. */
export const AuthorizationPolicy = Schema.Struct({
  actions: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literal("selected"), names: Schema.Array(Action) }),
  ]),
  tools: ToolSelection,
});
export type AuthorizationPolicy = typeof AuthorizationPolicy.Type;
/**
 * A tool as the live catalog describes it. Callers that only know a name pass no flag;
 * a read-only rule then denies it rather than guessing.
 */
export interface ToolIdentity {
  readonly name: ToolName;
  readonly readOnly?: boolean | undefined;
}
/** One invocation: the app, how it runs (omitted profile is the account-free app) and the tool. */
export interface ToolRequest {
  readonly app: AppId;
  readonly profile?: ProfileId | undefined;
  readonly tool: ToolIdentity;
}
/** Browser/full-consent policy. It never bypasses live organization or role checks. */
export const fullAuthority: AuthorizationPolicy = {
  actions: { kind: "all" },
  tools: { kind: "all" },
};
/** Missing authority fails closed, including an accidentally dropped request context. */
export const noAuthority: AuthorizationPolicy = {
  actions: { kind: "selected", names: [] },
  tools: { kind: "tools", apps: [] },
};
/** Build an explicit delegation; no protocol or credential type is inferred from the actions. */
export const selectedAuthority = (
  actions: readonly Action[],
  tools: ToolSelection,
): AuthorizationPolicy => ({ actions: { kind: "selected", names: actions }, tools });
/** Unclassified operations are available only under full user authority. */
export const permitsAction = (policy: AuthorizationPolicy, action: Action | undefined) =>
  policy.actions.kind === "all" || (action !== undefined && policy.actions.names.includes(action));
const scopeGrantsAny = (tools: ToolScope) => tools.kind !== "selected" || tools.names.length > 0;
const permissionTargets = (item: AppPermission) =>
  item.targets === undefined || item.targets.length > 0;
/** A selection exposes an app only when it grants at least one tool through at least one target. */
export const selectsApp = (selection: ToolSelection, app: AppId) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) => item.app === app && scopeGrantsAny(item.tools) && permissionTargets(item),
  );
const scopeSelects = (tools: ToolScope, tool: ToolIdentity) =>
  Match.value(tools).pipe(
    Match.when({ kind: "all" }, () => true),
    Match.when({ kind: "readOnly" }, () => tool.readOnly === true),
    Match.when({ kind: "selected" }, ({ names }) => names.includes(tool.name)),
    Match.exhaustive,
  );
const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "profile" && a.id === b.id;
const targetSelects = (item: AppPermission, profile: ProfileId | undefined) => {
  if (item.targets === undefined) return true;
  const target: RunTarget =
    profile === undefined ? { kind: "app" } : { kind: "profile", id: profile };
  return item.targets.some((allowed) => sameTarget(allowed, target));
};
/** Omitted profile means the account-free app target. A listed target set is exact. */
export const selectsTarget = (
  selection: ToolSelection,
  app: AppId,
  profile: ProfileId | undefined,
) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) => item.app === app && scopeGrantsAny(item.tools) && targetSelects(item, profile),
  );
/**
 * Tool names are exact identifiers, never patterns; read-only rules need the live flag.
 * The same permission entry must allow both the target and the tool.
 */
export const selectsTool = (selection: ToolSelection, request: ToolRequest) =>
  selection.kind === "all" ||
  selection.apps.some(
    (item) =>
      item.app === request.app &&
      targetSelects(item, request.profile) &&
      scopeSelects(item.tools, request.tool),
  );
/** Only a read-only rule needs the live catalog to decide; exact names and all-tools do not. */
export const requiresToolMetadata = (selection: ToolSelection, app: AppId) =>
  selection.kind === "tools" &&
  selection.apps.some((item) => item.app === app && item.tools.kind === "readOnly");
/** App discovery uses the same selection as execution. */
export const permitsApp = (policy: AuthorizationPolicy, app: AppId) =>
  permitsAction(policy, "discover") && selectsApp(policy.tools, app);
/** Discovery and execution share one tool identity check, with distinct operation authority. */
export const permitsTool = (
  policy: AuthorizationPolicy,
  request: ToolRequest,
  action: "discover" | "run" = "run",
) => permitsAction(policy, action) && selectsTool(policy.tools, request);
/** A profile or the account-free app may run only when the selection lists it for that app. */
export const permitsTarget = (
  policy: AuthorizationPolicy,
  app: AppId,
  profile: ProfileId | undefined,
) => permitsAction(policy, "discover") && selectsTarget(policy.tools, app, profile);
const targetsSubset = (
  previous: readonly RunTarget[] | undefined,
  next: readonly RunTarget[] | undefined,
) =>
  previous === undefined ||
  (next !== undefined && next.every((target) => previous.some((item) => sameTarget(item, target))));
const scopeSubset = (previous: ToolScope, next: ToolScope) =>
  Match.value(previous).pipe(
    Match.when({ kind: "all" }, () => true),
    // Exact names cannot be proven read-only without a live catalog, so only the rule narrows it.
    Match.when({ kind: "readOnly" }, () => next.kind === "readOnly"),
    Match.when(
      { kind: "selected" },
      ({ names }) => next.kind === "selected" && next.names.every((name) => names.includes(name)),
    ),
    Match.exhaustive,
  );
/** Narrowing cannot add future-tool access, names, or targets absent from one previous entry. */
export const isToolSelectionSubset = (previous: ToolSelection, next: ToolSelection): boolean => {
  if (previous.kind === "all") return true;
  if (next.kind === "all") return false;
  return next.apps.every((item) =>
    previous.apps.some(
      (before) =>
        before.app === item.app &&
        targetsSubset(before.targets, item.targets) &&
        scopeSubset(before.tools, item.tools),
    ),
  );
};
/** Apply an app filter before fetching inventory; an empty result stays an explicit empty list. */
export const permittedAppIds = (
  policy: AuthorizationPolicy,
  requested?: readonly AppId[],
): readonly AppId[] | undefined => {
  if (!permitsAction(policy, "discover")) return [];
  return Match.value(policy.tools).pipe(
    Match.when({ kind: "all" }, () => requested),
    Match.when({ kind: "tools" }, ({ apps }) => [
      ...new Set(
        apps
          .filter(
            (item) =>
              selectsApp(policy.tools, item.app) &&
              (requested === undefined || requested.includes(item.app)),
          )
          .map((item) => item.app),
      ),
    ]),
    Match.exhaustive,
  );
};
