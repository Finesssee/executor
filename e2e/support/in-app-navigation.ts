/** Client-side navigation in a running dashboard, as a link click performs it. */
import { Effect } from "effect";
import { Browser } from "./browser.ts";

/**
 * A document load arrives with its data rendered on the server, so its loading states are never
 * shown in the browser. A navigation inside the running page reads through the browser, which is
 * where held requests and loading states can be observed. The page must already be a hydrated
 * dashboard document.
 */
export const openInApp = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(label, (page) =>
      page.evaluate((to) => window.history.pushState(window.history.state, "", to), path),
    );
  });

/** A dashboard page that reads no app, account or resource data. */
const neutralPage = (path: string) => {
  const organization = /^\/org\/([^/?#]+)/.exec(path)?.[1];
  return organization === undefined ? "/connect" : `/org/${organization}/connect`;
};

/**
 * Load a dashboard page that does not read the destination's data, then navigate to the
 * destination in the browser so its reads, holds and fixtures apply there.
 */
export const openThroughBrowser = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const origin = new URL(path, "http://dashboard.invalid");
    yield* browser.use(`${label}: start from another page`, (page) =>
      page.goto(
        origin.origin === "http://dashboard.invalid"
          ? neutralPage(path)
          : new URL(neutralPage(origin.pathname), origin).href,
      ),
    );
    yield* openInApp(
      label,
      origin.origin === "http://dashboard.invalid" ? path : origin.pathname + origin.search,
    );
  });
