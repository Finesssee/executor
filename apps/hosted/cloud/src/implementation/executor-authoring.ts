/** The Executor authoring reference embedded at build time. It is large: import this module on demand. */
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import authoring from "../../.generated/executor-authoring.json" with { type: "json" };

export const executorAuthoringSkills = executorSkillFiles(authoring);
