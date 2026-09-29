import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Profile, sharedProfileFixture } from "../support/hosted-profile.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const SetupStatus = Schema.Struct({ status: Schema.String, failure: Schema.NullOr(Schema.String) });
layer(HostedLive, { excludeTestServices: true })("Hosted profiles", (it) => {
  it.effect(scenarios.hostedProfileScheduling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, alice, bob } = yield* sharedProfileFixture;
        for (const [actor, id] of [
          [actors.member, alice.id],
          [actors.admin, bob.id],
        ] as const) {
          const deadline = (yield* Clock.currentTimeMillis) + 30000;
          for (;;) {
            const response = yield* api.request(actor, "POST", `${path}/profiles/${id}/reconcile`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const ready = yield* body(Profile, response);
            if (ready.status === "ready") break;
            expect(ready.status, JSON.stringify(response.body)).toBe("pending");
            expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
            yield* Effect.sleep("200 millis");
          }
          expect(
            (yield* api.request(actor, "PATCH", `${path}/schedules/tick`, {
              profile: id,
              enabled: true,
            })).status,
          ).toBe(200);
        }
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/schedules/tick`, {
            profile: bob.id,
            enabled: false,
          })).status,
        ).toBe(403);
        const run = yield* Effect.acquireRelease(
          api
            .request(actors.admin, "POST", `${path}/workflow-runs`, {
              profile: bob.id,
              workflow: "capture",
              input: {},
              key: "shared-context",
            })
            .pipe(Effect.flatMap((response) => body(Resource, response))),
          // The forbidden termination below must leave the run untouched. Its
          // actual owner releases it before profiles, accounts and the app.
          (run) =>
            Effect.gen(function* () {
              const stopped = yield* api.request(
                actors.admin,
                "POST",
                `${path}/workflow-runs/${run.id}/terminate`,
              );
              expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
              expect(stopped.body).toMatchObject({ id: run.id });
            }).pipe(Effect.orDie),
        );
        expect(
          (yield* api.request(actors.member, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${path}/workflow-runs/${run.id}/terminate`))
            .status,
        ).toBe(403);
      }),
    ),
  );
  // Schedules only target declared mutations. Profile setup and schedule controls
  // must not wait on, or fail with, a dynamic catalog that is slow or unavailable.
  it.effect(scenarios.hostedProfileStaticSchedules.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Static schedules ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicRouter, mutation, object, interval, router } from "apps";
const tick = mutation({ input: object({}) }, async () => "ticked");
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    tick,
    catalog: dynamicRouter({
      list: async () => { throw new Error("Dynamic catalog unavailable"); },
      resolve: async () => undefined,
    }),
  }),
  schedules: { tick: interval({ minutes: 1 }, tick, {}) },
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const path = `${prefix}/${(yield* body(App, deployed)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(actors.owner, path);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`).pipe(Effect.orDie),
        );
        // The dynamic catalog really fails. Its router reports the failure while the declared
        // mutation still lists.
        const catalog = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
        expect(catalog.body).toMatchObject({
          items: [{ name: "tick" }],
          routers: [{ path: "catalog", error: { _tag: "HostEvaluationFailed" } }],
        });
        const deadline = (yield* Clock.currentTimeMillis) + 30000;
        let setup = yield* body(
          SetupStatus,
          yield* api.request(actors.owner, "POST", `${path}/profiles/${profile.id}/reconcile`),
        );
        while (setup.status === "pending") {
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("200 millis");
          setup = yield* body(
            SetupStatus,
            yield* api.request(actors.owner, "POST", `${path}/profiles/${profile.id}/reconcile`),
          );
        }
        expect(setup).toMatchObject({ status: "ready", failure: null });
        const definitions = yield* api.request(
          actors.owner,
          "GET",
          `${path}/schedules/definitions?profile=${profile.id}`,
        );
        expect(definitions.status, JSON.stringify(definitions.body)).toBe(200);
        expect(definitions.body).toMatchObject([{ name: "tick", tool: "tick" }]);
        const enabled = yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
          profile: profile.id,
          enabled: true,
        });
        expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
        expect(enabled.body).toMatchObject({ name: "tick", enabled: true });
      }),
    ),
  );
});
