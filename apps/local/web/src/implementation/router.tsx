import { documentValues } from "@executor-js/dashboard-start/api";
import { dashboardRegistry } from "@executor-js/dashboard-start/registry";
import { Effect } from "effect";
import { createRouter, stringifySearchWith } from "@tanstack/react-router";
import { parseSearchParams, type NavigationSection } from "../contracts/navigation.ts";
import { readAccountConnection } from "./account-connections.ts";
import { readPairingToken } from "./connection.ts";
import { readOAuthCallback } from "./oauth.ts";
import { routeTree } from "./routeTree.gen.ts";
import { serverDocument } from "./document.ts";

/**
 * Browser entry credentials live in the URL fragment or query. Consume and erase them before the
 * router reads the location. They are applied after hydration, because the server rendered the
 * page without them; see `BrowserEntry`.
 */
const readBrowserEntry = () => ({
  pairingToken: Effect.runSync(readPairingToken),
  oauthCallback: Effect.runSync(readOAuthCallback),
  connection: Effect.runSync(readAccountConnection),
});
export type BrowserEntryValues = ReturnType<typeof readBrowserEntry>;

/** One router and atom registry per document request on the server, and one per page in the browser. */
export function getRouter() {
  const { connect, Wrap } = dashboardRegistry(
    import.meta.env.SSR ? documentValues(serverDocument()) : [],
  );
  const entry = import.meta.env.SSR ? undefined : readBrowserEntry();
  return connect(
    createRouter({
      routeTree,
      context: { entry },
      defaultPreload: "intent",
      // Existing links use ordinary strings, including tool names such as "123".
      parseSearch: parseSearchParams,
      stringifySearch: stringifySearchWith(JSON.stringify),
      scrollRestoration: true,
      scrollToTopSelectors: ["main.main"],
      Wrap,
    }),
  );
}

/** The router registered for typed links, route params and navigation. */
export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    section?: NavigationSection;
  }
}
