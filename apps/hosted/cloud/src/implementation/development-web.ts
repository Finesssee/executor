/** Vite's middleware is a fallback handler; the Effect server owns route selection and TLS. */
import type { Server } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { dashboardDocument, type DashboardServer } from "@executor-js/dashboard-start/document";
import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";
import { HostPipeline } from "@executor-js/dashboard-start/in-process";
import { cloudDocumentContext } from "./dashboard.ts";
import type { CloudEntryPage } from "../contracts/entry.ts";
import { Effect, Path } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createServer, isRunnableDevEnvironment } from "vite-plus";
import { DevelopmentWebFailed } from "../contracts/development.ts";

/**
 * Render documents with the Worker's handler loaded through Vite, and serve other files from Vite.
 * Only the dedicated listener receives HMR upgrades.
 * `hmrOrigin` is the scheme and hostname the browser uses to reach that listener.
 */
export const developmentDashboard = (
  root: string,
  server: Server,
  hmrOrigin: URL,
  apiOrigin: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* new DevelopmentWebFailed({ stage: "vite" });
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createServer({
            root,
            server: {
              middlewareMode: true,
              ws: {
                server,
                host: hmrOrigin.hostname,
                clientPort: address.port,
                protocol: hmrOrigin.protocol === "https:" ? "wss" : "ws",
              },
            },
          }),
        catch: () => new DevelopmentWebFailed({ stage: "vite" }),
      }),
      (vite) => Effect.promise(() => vite.close()),
    );
    const ssr = vite.environments.ssr;
    if (ssr === undefined || !isRunnableDevEnvironment(ssr))
      return yield* new DevelopmentWebFailed({ stage: "vite" });
    // The same document handler the Worker uses, reloaded by Vite when its modules change.
    const document = (entry: CloudEntryPage | null) =>
      dashboardDocument({
        server: Effect.tryPromise({
          try: () =>
            ssr.runner.import<{ default: DashboardServer<CloudDocumentContext> }>(
              path.join(root, "src/server.ts"),
            ),
          catch: () => new DevelopmentWebFailed({ stage: "vite" }),
        }).pipe(Effect.map((module) => module.default)),
        context: cloudDocumentContext(entry),
      }).pipe(
        // The development API runs in its own workerd process, so rendering reaches it over loopback.
        // Deployed Workers dispatch the same reads in-process.
        Effect.provideService(HostPipeline, (request) => {
          const url = new URL(request.url);
          return fetch(new URL(url.pathname + url.search, apiOrigin), request);
        }),
      );
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      const outgoing = NodeHttpServerRequest.toServerResponse(request);
      return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
        const cleanup = () => {
          outgoing.off("finish", done);
          outgoing.off("close", done);
        };
        const done = () => {
          cleanup();
          resume(Effect.succeed(HttpServerResponse.empty({ status: outgoing.statusCode })));
        };
        outgoing.once("finish", done);
        outgoing.once("close", done);
        vite.middlewares(incoming, outgoing, (error?: unknown) => {
          cleanup();
          resume(
            Effect.succeed(
              HttpServerResponse.text(
                error === undefined ? "Not found" : "Development UI unavailable",
                { status: error === undefined ? 404 : 500 },
              ),
            ),
          );
        });
        return Effect.sync(cleanup);
      });
    });
    return { document, handler };
  });
