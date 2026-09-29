/** Bind the app data Worker without importing its implementation. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { AppDataSupervisor } from "./app-data.ts";

/** Hosts every app's data supervisor, so waking one never starts the API Worker. */
export class AppData extends Cloudflare.Worker<AppData, {}, AppDataSupervisor>()("AppData") {}
