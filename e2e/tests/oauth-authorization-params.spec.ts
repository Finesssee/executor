/** Declared authorization parameters reach the sign-in URL; protocol parameters stay host-owned. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });
const extras = { access_type: "offline", prompt: "consent" };

layer(HostedLive, { excludeTestServices: true })("OAuth authorization parameters", (it) => {
  it.effect(scenarios.oauthAuthorizationParams.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ scopes: ["read"], authMethods: ["client_secret_basic"] });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (config: object) =>
          api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `OAuth parameters ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Parameterized OAuth",auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
              },
              appsManifest,
            ],
          });
        const start = (config: object, client?: object) =>
          Effect.gen(function* () {
            const deployed = yield* deploy(config);
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(Resource, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label: "Parameterized", ...(client ? { client } : {}) },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const signIn = yield* body(SignIn, started);
            const url = new URL(signIn.authorizationUrl);
            // Declared extras arrive once, beside every protocol parameter Executor owns.
            for (const [key, value] of Object.entries(extras))
              expect(url.searchParams.getAll(key)).toEqual([value]);
            expect(url.searchParams.get("response_type")).toBe("code");
            expect(url.searchParams.get("redirect_uri")).toBe(signIn.redirectUri);
            expect(url.searchParams.get("scope")).toBe("read");
            expect(url.searchParams.get("state")).toMatch(/.{16,}/);
            expect(url.searchParams.get("code_challenge")).toMatch(/.{32,}/);
            expect(url.searchParams.get("code_challenge_method")).toBe("S256");
            return { url, connection: connection.id, profile: profile.id, app: app.id };
          });

        const discovered = yield* start({
          discover: `${issuer.origin}/mcp`,
          scopes: ["read"],
          resource: null,
          authorizationParams: extras,
        });
        expect(`${discovered.url.origin}${discovered.url.pathname}`).toBe(
          `${issuer.origin}/authorize`,
        );
        expect(discovered.url.searchParams.get("client_id")).toMatch(/^synthetic-client-/);

        const declared = yield* start(
          {
            authorizationUrl: `${issuer.origin}/authorize?tenant=fixture`,
            tokenUrl: `${issuer.origin}/token`,
            scopes: ["read"],
            tokenEndpointAuthMethod: "client_secret_basic",
            authorizationParams: extras,
          },
          { clientId: "synthetic-declared-client", clientSecret: "synthetic-client-secret" },
        );
        expect(`${declared.url.origin}${declared.url.pathname}`).toBe(`${issuer.origin}/authorize`);
        expect(declared.url.searchParams.get("tenant")).toBe("fixture");
        expect(declared.url.searchParams.get("client_id")).toBe("synthetic-declared-client");

        // Complete the discovered sign-in: the extras change nothing after authorization.
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(discovered.url.href);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${discovered.connection}/oauth/complete`,
          { callbackUrl },
        );
        expect(
          completed.status,
          `${JSON.stringify(completed.body)} checks=${JSON.stringify((yield* issuer.metrics).tokenChecks)}`,
        ).toBe(200);
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges + 1);
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${discovered.app}/profiles/${discovered.profile}`,
          )).body,
        ).toMatchObject({ accounts: { service: account.id } });

        // A declaration cannot replace a host-owned protocol parameter. The same declaration
        // without the reserved key deploys, so the reserved key alone causes the rejection.
        for (const [config, reserved] of [
          [{ discover: `${issuer.origin}/mcp`, scopes: ["read"] }, { state: "fixed" }],
          [
            {
              authorizationUrl: `${issuer.origin}/authorize`,
              tokenUrl: `${issuer.origin}/token`,
              scopes: ["read"],
            },
            { redirect_uri: "https://redirect.example.test/callback" },
          ],
        ] as const) {
          const rejected = yield* deploy({
            ...config,
            authorizationParams: { ...extras, ...reserved },
          });
          expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
          expect(rejected.body).toMatchObject({
            _tag: "DeploymentBuildFailed",
            reason: "App build failed",
          });
          const accepted = yield* deploy({ ...config, authorizationParams: extras });
          expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
          const app = yield* body(Resource, accepted);
          yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie);
        }
      }),
    ),
  );
});
