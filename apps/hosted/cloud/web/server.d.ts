/** Types for the built document handler at `dist/server/server.js`; see `src/server.ts`. */
import type { DashboardServer } from "@executor-js/dashboard-start/document";
import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";

declare const server: DashboardServer<CloudDocumentContext>;
export default server;
