import { expect, layer } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { Effect, Result, Schedule } from "effect";
import { Actors, freshOwnerSession } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
/** A document navigation, as a browser sends it. */
const navigation = { accept: "text/html" };

layer(HostedLive, { excludeTestServices: true })("Server-rendered dashboard", (it) => {
  it.effect(scenarios.serverRenderedDashboard.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const telemetry = yield* Telemetry;
        // Repeated and encoded parameters stand in for a signed OAuth query that must survive.
        const destination = `/org/${actors.organization.slug}/apps?view=accounts&scope=a%20b&scope=c`;

        const signedOut = yield* browser.use("Request a protected page while signed out", (page) =>
          page.context().request.get(destination, { maxRedirects: 0, headers: navigation }),
        );
        expect(signedOut.status()).toBeGreaterThanOrEqual(300);
        expect(signedOut.status()).toBeLessThan(400);
        expect(signedOut.headers()["location"]).toBe(
          `/login?redirect=${encodeURIComponent(destination)}`,
        );

        yield* browser.login(yield* freshOwnerSession);
        const failures: string[] = [];
        const repeatedReads: string[] = [];
        yield* browser.use("Watch hydration and the page's own reads", (page) => {
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            // Server-rendered reads reach the browser with the page instead of being repeated.
            if (/^\/api\/organizations\/[^/]+\/(inventory|access)$/.test(path))
              repeatedReads.push(path);
          });
          return Promise.resolve();
        });

        // An organization root opens its apps.
        const root = yield* browser.use("Request an organization root", (page) =>
          page.context().request.get(`/org/${actors.organization.slug}`, {
            maxRedirects: 0,
            headers: navigation,
          }),
        );
        expect(root.status()).toBe(307);
        expect(new URL(root.headers()["location"] ?? "", "http://dashboard.invalid").pathname).toBe(
          `/org/${actors.organization.slug}/apps`,
        );

        const response = yield* browser.use("Open the apps page", (page) => page.goto(destination));
        if (response === null) throw new Error("The dashboard did not return a document");
        expect(response.status()).toBe(200);
        const headers = response.headers();
        expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(headers["x-frame-options"]).toBe("DENY");
        expect(headers["x-content-type-options"]).toBe("nosniff");
        expect(headers["cache-control"]).toContain("no-store");
        expect(headers["vary"]).toContain("Cookie");
        const html = yield* browser.use("Read the document the server sent", () => response.text());
        // Reads made while the page streams are recorded in the document's own trace. The
        // document continues the trace its request carries.
        const traceId = randomBytes(16).toString("hex");
        const traced = yield* browser.use("Request the apps page in a known trace", (page) =>
          page
            .context()
            .request.get(destination, {
              headers: {
                ...navigation,
                traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
              },
            })
            .then((document) => document.text()),
        );
        expect(traced).toMatch(/>Executor</);
        const recorded = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((value) =>
            value.data.some((entry) =>
              /^\/api\/organizations\/[^/]+\/resources$/.test(entry.span.tags["url.path"] ?? ""),
            )
              ? Effect.void
              : Effect.fail(new Error("The page's API read is not in the document trace")),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          Effect.timeout("20 seconds"),
          Effect.result,
        );
        expect(
          Result.isSuccess(recorded),
          "The apps read made during rendering must be recorded in the document trace",
        ).toBe(true);
        // The installed app's card is data the server read before sending the page.
        expect(html).toContain('aria-label="Organization:');
        expect(html).toMatch(/>Executor</);

        yield* browser.use("The page is interactive with the server's content", (page) =>
          page.getByRole("heading", { name: /^Apps(?:\s*\d+)?$/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Let every streamed region hydrate", (page) =>
          page.waitForTimeout(1500),
        );
        expect(failures).toEqual([]);
        expect(repeatedReads).toEqual([]);
        yield* browser.checkpoint("Server-rendered apps page after hydration");

        const consent = yield* browser.use("Open the MCP consent page", (page) =>
          page.context().request.get("/mcp/authorize?client_id=unknown&response_type=code", {
            headers: navigation,
          }),
        );
        expect(consent.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(consent.headers()["x-frame-options"]).toBe("DENY");
      }),
    ),
  );
});
