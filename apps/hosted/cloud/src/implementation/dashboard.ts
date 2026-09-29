/** Cloud's dashboard document adapter. Static assets stay on Cloudflare's asset server. */
import { dashboardDocument } from "@executor-js/dashboard-start/document";
import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import { hostedDocumentContext } from "@executor-js/hosted-server/document";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { CloudEntryPage } from "../contracts/entry.ts";
import { betaNoticeDismissed } from "@executor-js/hosted-cloud-web/document";
import dashboardRoutes from "@executor-js/hosted-cloud-web/routes";

/**
 * API-only isolates never load React. The renderer is imported on the first page request and the
 * module is reused by later requests in the isolate; it holds no request or user state.
 */
const server = Effect.promise(() => import("@executor-js/hosted-cloud-web/server")).pipe(
  Effect.map((module) => module.default),
  Effect.withSpan("dashboard.load"),
);

/** Cloud pages also receive the sign-in or setup data resolved for this request, if any. */
export const cloudDocumentContext = (entry: CloudEntryPage | null) => (api: DocumentApi) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const document = yield* hostedDocumentContext(api);
    return {
      ...document,
      entry,
      betaNoticeDismissed: betaNoticeDismissed(request.headers.cookie ?? ""),
    };
  });

/** Render one dashboard document for the current request. */
export const cloudDashboard = (entry: CloudEntryPage | null) =>
  dashboardDocument({ server, context: cloudDocumentContext(entry) });

/**
 * Page routes the Worker renders directly. Sign-in and team setup are resolved first by the entry
 * handler. The router matches a trailing slash itself; only Cloudflare's list needs both forms.
 */
export const dashboardPageRoutes = dashboardRoutes.filter(
  (route): route is `/${string}` =>
    route.startsWith("/") &&
    !route.endsWith("/") &&
    !["/login", "/login/sso", "/create"].includes(route),
);

/**
 * An organization root opens its apps. The Worker answers it before any document work: the
 * redirect needs no session, because the destination checks it, so it costs one round trip
 * rather than a session lookup and a render. The router applies the same redirect in the browser.
 */
export const organizationRoot = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://executor.internal");
  return HttpServerResponse.redirect(`${url.pathname.replace(/\/?$/, "/apps")}${url.search}`, {
    status: 307,
  });
});
