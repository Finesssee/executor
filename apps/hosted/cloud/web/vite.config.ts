import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dashboardViteConfig } from "@executor-js/hosted-web/vite";
import { mergeConfig } from "vite-plus";
import { cloudflareRoutes } from "./cloudflare-routes.ts";

const apiUrl = process.env.HOSTED_API_URL ?? "http://127.0.0.1:4411";

export default mergeConfig(
  dashboardViteConfig({
    apiUrl,
    port: 4412,
  }),
  {
    // Cloud's IaC serves documentation beside the dashboard on every stage.
    define: { "import.meta.env.VITE_EXECUTOR_DOCS_BASE_URL": JSON.stringify("/docs/") },
    // The development dashboard delegates docs to the Worker's built static assets.
    server: { proxy: { "/docs": apiUrl } },
    build: { sourcemap: "hidden" },
    plugins: [
      cloudflareRoutes(),
      ...(process.env.SENTRY_AUTH_TOKEN
        ? [
            sentryVitePlugin({
              telemetry: false,
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
    ],
  },
);
