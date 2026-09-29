/**
 * Host protocol 5: protocol 4 plus account checks.
 *
 * Builds declare which account slots have a provider check, and hosts can ask a build to check one
 * account for one slot without evaluating the app. Every other message is protocol 4's, re-exported
 * unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol5` with
 * `packages/apps/protocols/5.json`. Define the next protocol instead of editing this file.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { DatabaseSchema } from "@executor-js/app-data/contracts";
import { AccountCheckResult } from "../provider.ts";
import { WorkflowReplay, WorkflowRunId } from "../workflows.ts";
import {
  DeclaredProvider,
  InvocationDeadline,
  ResolvedAccounts,
  TrustedToolApproval,
  protocol4,
} from "./4.ts";

export * from "./4.ts";

/** Account slots available without binding accounts or evaluating the app factory. */
export const DeclaredRequirements = Schema.Struct({
  /** Protocol support of this retained framework build, not an author-declared requirement. */
  capabilities: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Literal(true),
      toolIndex: Schema.optionalKey(Schema.Literal(true)),
      skillSources: Schema.optionalKey(Schema.Literal(true)),
      scheduledTools: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  database: Schema.optionalKey(DatabaseSchema),
  accounts: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      definition: DeclaredProvider,
      cardinality: Schema.Literals(["one", "many"]),
      /**
       * The slot's provider defines an account check. Kept beside the definition, not in it, so
       * adding or editing a check never changes the provider's identity.
       */
      health: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});
/** Parsed declared account requirements. */
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/**
 * Check one account for one declared slot. The invocation supplies only that slot, as a single
 * account even when the slot takes many. The app factory is not evaluated.
 */
export const AccountCheckCommand = Schema.Struct({
  operation: Schema.Literal("account-check"),
  requirement: Schema.NonEmptyString,
});
export type AccountCheckCommand = typeof AccountCheckCommand.Type;

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
  ...protocol4.schemas.request.members,
  AccountCheckCommand,
]);
/** Parsed portable dispatch request. */
export type HostRequest = typeof HostRequest.Type;

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  command: HostRequest,
  accounts: ResolvedAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  workflowRun: Schema.optionalKey(WorkflowRunId),
});
export type HostInvocation = typeof HostInvocation.Type;

/** Every message of protocol 5, in the order its snapshot records them. */
export const protocol5 = {
  version: 5,
  schemas: {
    ...protocol4.schemas,
    invocation: HostInvocation,
    request: HostRequest,
    requirements: DeclaredRequirements,
    accountCheck: AccountCheckResult,
  },
} as const;
