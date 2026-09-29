import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Early form submission", (it) => {
  it.effect(scenarios.earlyFormSubmission.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const addresses: string[] = [];
        let releaseScripts = () => {};
        const scriptsHeld = new Promise<void>((resolve) => {
          releaseScripts = resolve;
        });
        yield* browser.use("Hold the dashboard's scripts so the page cannot hydrate", (page) => {
          page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) addresses.push(frame.url());
          });
          return page.route(/\/assets\/[^/]+\.js$/, (route) =>
            scriptsHeld.then(() => route.fallback()),
          );
        });
        // One step: each step afterwards waits for the page to become interactive.
        expect(
          yield* browser.use(
            "Sign in on the server-rendered page before it is interactive",
            (page) =>
              page
                .goto("/login", { waitUntil: "commit" })
                .then(() => page.getByLabel("Email", { exact: true }).fill("owner@example.test"))
                .then(() => page.getByLabel("Password", { exact: true }).fill(password))
                .then(() => page.getByRole("button", { name: "Sign in", exact: true }).click())
                .then(() =>
                  page.evaluate(() => document.documentElement.hasAttribute("data-hydrated")),
                ),
          ),
          "the submission happened before hydration",
        ).toBe(false);
        // A native submission would have sent the fields in the address.
        const leaked = () =>
          addresses.filter(
            (address) =>
              new URL(address).searchParams.has("password") ||
              address.includes("owner%40example.test"),
          );
        expect(leaked(), "the early submission must not navigate with its fields").toEqual([]);
        yield* browser.use("Let the page hydrate", () => {
          releaseScripts();
          return Promise.resolve();
        });
        yield* browser.use("The held submission signs in once the page is interactive", (page) =>
          page.waitForURL(`**/org/${actors.organization.slug}/apps`),
        );
        expect(leaked()).toEqual([]);
      }),
    ),
  );
});
