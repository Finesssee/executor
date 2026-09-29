/** Shared build tooling. Each dashboard supplies its own root, routes, and API target. */
import { fileURLToPath } from "node:url";
import { dashboardStartPlugins } from "@executor-js/dashboard-start/vite";
import { defineConfig } from "vite-plus";

/** Configure a host's dashboard without importing another host's frontend. */
export const dashboardViteConfig = ({
  apiUrl,
  port,
}: {
  readonly apiUrl: string;
  readonly port: number;
}) =>
  defineConfig({
    publicDir: fileURLToPath(new URL("./public", import.meta.url)),
    plugins: dashboardStartPlugins({
      runtime: "workerd",
      router: {
        codeSplittingOptions: {
          splitBehavior: ({ routeId }) => (routeId === "/org/$organizationSlug" ? [] : undefined),
        },
      },
    }),
    server: {
      host: "127.0.0.1",
      port: process.env.PORT === undefined ? port : Number(process.env.PORT),
      strictPort: true,
      proxy: {
        "/api": apiUrl,
        "/health": apiUrl,
        "/openapi.json": apiUrl,
        "^/mcp$": apiUrl,
        "^/org/[^/]+/mcp$": apiUrl,
        "/.well-known": apiUrl,
      },
    },
  });
