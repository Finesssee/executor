import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Resource = Schema.Struct({ id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("MCP empty state", (it) => {
  it.effect(scenarios.emptyStateMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        // A real account whose only membership was removed; the server reads its organizations.
        const email = `former-${randomUUID()}@example.test`;
        const invitation = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
            email,
            role: "member",
            organizationId: actors.organization.id,
          }),
        );
        const former = yield* api.session();
        expect(
          (yield* api.request(former, "POST", "/api/auth/self-host/register", {
            invitation: invitation.id,
            email,
            password,
            name: "Former member",
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: email,
          })).status,
        ).toBe(200);
        yield* browser.login(former);
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        yield* browser.use("Provide synthetic client metadata", (page) =>
          page.route("**/api/auth/oauth2/public-client?*", (route) =>
            route.fulfill({
              json: {
                client_id: "empty-state-client",
                client_name: "Example client",
              },
            }),
          ),
        );
        for (const viewport of [
          { width: 1440, height: 960 },
          { width: 390, height: 844 },
        ]) {
          yield* browser.use("Set consent viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("Open consent without organizations", (page) =>
            page.goto(
              `/mcp/authorize?client_id=empty-state-client&resource=${encodeURIComponent(`${target.metadata.origin}/api`)}`,
            ),
          );
          yield* browser.use("Consent gives the actual recovery step", (page) =>
            page
              .getByText(
                "Ask an organization admin for an invitation, then return here to connect.",
                { exact: true },
              )
              .waitFor(),
          );
          expect(
            yield* browser.use("No unusable organization selector", (page) =>
              page.getByRole("combobox").count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("No impossible Connect action", (page) =>
              page.getByRole("button", { name: "Connect", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.checkpoint(`${viewport.width} consent without organization membership`);
        }
      }),
    ),
  );
});
