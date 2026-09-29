/** Compile with the npm `apps` framework the app declares; Cloud supplies no framework of its own. */
import { compileWorkerApp } from "@executor-js/sdk/workerd/build";
import type { SourceFiles } from "@executor-js/sdk/core";

export const compileCloudApp = (files: SourceFiles, registry: string | undefined) =>
  compileWorkerApp(files, registry === undefined ? {} : { registry });
