import { defineApp, router } from "apps";
import { requirements } from "./context.ts";
import { listReports, saveReport, startReport, reportRuns } from "./operations.ts";
import { report } from "./workflows.ts";
export default defineApp(requirements, {
  tools: router({
    listReports,
    reportRuns,
    saveReport,
    startReport,
  }),
  workflows: { report },
});
