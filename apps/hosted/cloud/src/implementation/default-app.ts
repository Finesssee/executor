/** The default management app is assembled only when its owning organization needs it. */
import { organizationDefaults } from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import type { Executor, ExecutorDatabase } from "@executor-js/sdk/core";
import type { Effect } from "effect";
import { executorAuthoringSkills } from "./executor-authoring.ts";
export { executorCloudApiDocument } from "../contracts/api.ts";

/** Load the management contract and authoring material behind this feature's module boundary. */
export const defaultApp = (
  executor: Executor,
  origin: string,
  storage: ExecutorDatabase,
  document: Effect.Effect<HostedApiDocument>,
) => organizationDefaults(executor, origin, storage, executorAuthoringSkills, document);
