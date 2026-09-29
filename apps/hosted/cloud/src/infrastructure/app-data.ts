/** Native Alchemy resource; product authorization remains on the calling Worker. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { makeFacetSupervisor } from "@executor-js/app-data/cloudflare";
import { AppData } from "./app-data-worker.ts";

type Supervisor = Pick<
  Effect.Success<ReturnType<typeof makeFacetSupervisor>>,
  "invoke" | "cancel" | "cache" | "evaluated"
>;
/**
 * One supervisor name is one immutable configured-app ID, across deployments. The namespace, with
 * every app's data, moved here from the API Worker.
 */
export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()(
  "AppDataSupervisor",
  { transferredFrom: "Api" },
) {}

/** Every other Worker binds the namespace across scripts. */
export const appDataSupervisors = AppDataSupervisor.from(AppData);
