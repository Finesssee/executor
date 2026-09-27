/** Renewal failures are classified from the token endpoint's real wire responses. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SetupStatus = Schema.Struct({ status: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Echo = Schema.Struct({
  refreshed: Schema.Boolean,
  authorization: Schema.NullOr(Schema.String),
});
const Read = Schema.Record(Schema.String, Echo);
/** The access token issued at sign-in (0) or by the issuer's nth refresh request. */
const presented = (generation: number) => ({
  refreshed: generation > 0,
  authorization:
    generation === 0
      ? "Bearer synthetic-access-token"
      : `Bearer synthetic-refreshed-token-${generation}`,
});
type TokenError = Exclude<
  Parameters<Effect.Success<typeof oauthSetupIssuer>["configure"]>[0]["tokenError"],
  null | undefined
>;
const privateError = { error_description: "PRIVATE_PROVIDER_ERROR" };
/**
 * How the token endpoint answers a refresh: an outage (503), rate limit (429), an OAuth
 * `server_error` or `temporarily_unavailable` error body with HTTP 400, a dropped
 * connection, a 200 without an access token, or a revoked grant (`invalid_grant`).
 */
const refreshFailures = {
  unavailable: { status: 503, body: {} },
  rate_limited: { status: 429, body: {} },
  server_error: { status: 400, body: { error: "server_error", ...privateError } },
  temporarily_unavailable: {
    status: 400,
    body: { error: "temporarily_unavailable", ...privateError },
  },
  connection_reset: "reset",
  malformed: { status: 200, body: { token_type: "Bearer", expires_in: 20 } },
  invalid_grant: { status: 400, body: { error: "invalid_grant", ...privateError } },
} satisfies Record<string, TokenError>;
type RefreshFailure = keyof typeof refreshFailures;
const Failure = Schema.Struct({
  _tag: Schema.String,
  account: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  cause: Schema.optional(
    Schema.Struct({
      stage: Schema.String,
      status: Schema.optional(Schema.Number),
      providerError: Schema.optional(Schema.String),
    }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("OAuth refresh resilience", (it) => {
  it.effect(scenarios.oauthRefreshResilience.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Tokens issued inside the host's 30-second renewal window renew on the next use.
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
        const name = `Renewal ${randomUUID().slice(0, 8)}`;
        /** Deploy an app whose query presents each listed slot's token to the issuer's resource. */
        const deploy = (appName: string, slots: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const reads = slots
              .map(
                (slot) =>
                  `${slot}: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.${slot}.fields.access_token } })).json()`,
              )
              .join(", ");
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: appName,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, query, object } from "apps";
const service = defineProvider({ name: ${JSON.stringify(appName)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { ${slots.map((slot) => `${slot}: service`).join(", ")} } }, async ({ accounts }) => ({
  queries: {
    read: query({ input: object({}) }, async ({ fetch }) => ({ ${reads} })),
  },
}));`,
                },
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(AppProvider, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const app = yield* deploy(name, ["service"]);
        const provider = app.requirements.accounts.service.provider;

        /** Wait until background profile setup, which resolves the profile's accounts, is done. */
        const settled = (appId: string, profile: string) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${appId}/profiles/${profile}`).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status !== "pending"
                ? Effect.void
                : Effect.fail(new Error("Profile setup has not finished")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

        const connect = (label: string, appId = app.id) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${appId}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${appId}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            const account = yield* body(Resource, completed);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                .pipe(Effect.orDie),
            );
            // Profile setup resolves the new account in the background. Let it finish so each
            // renewal below belongs to the call that the scenario makes.
            yield* settled(appId, profile.id);
            return { profile: profile.id, account: account.id };
          });
        const read = (profile: string) =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            profile,
            tool: "queries.read",
            input: {},
          });
        const expectRead = (profile: string, generation: number) =>
          Effect.gen(function* () {
            const response = yield* read(profile);
            expect(
              response.status,
              `${JSON.stringify(response.body)}, checks=${JSON.stringify((yield* issuer.metrics).refreshChecks)}`,
            ).toBe(200);
            expect(yield* body(Read, response)).toEqual({ service: presented(generation) });
          });
        const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
        const assertPrivate = (value: unknown) => {
          const json = JSON.stringify(value);
          for (const marker of [
            "PRIVATE_PROVIDER_ERROR",
            "synthetic-refresh-",
            "synthetic-client-secret",
            "synthetic-access-token",
          ])
            expect(json).not.toContain(marker);
        };
        const spans = Effect.gen(function* () {
          const id = (yield* evidence.requests).at(-1)?.traceId;
          if (id === undefined) return yield* Effect.die("Missing request trace");
          return yield* telemetry.query(id).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.operationName === "oauth.resolve")
                ? Effect.succeed(result)
                : Effect.fail(new Error("Request trace has not arrived")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
          );
        });

        const renewing = yield* connect("Synthetic renewing account");
        const first = (yield* refreshes) + 1;
        yield* expectRead(renewing.profile, first);
        expect(yield* refreshes).toBe(first);

        // One call renews a grant once, even when the account fills two slots and the renewed
        // token already falls inside the renewal window: the second slot uses that token.
        {
          const pair = yield* deploy(`${name} pair`, ["service", "backup"]);
          const shared = yield* connect("Synthetic shared account", pair.id);
          const selected = yield* selectProfileAccounts(
            actors.owner,
            `${prefix}/apps/${pair.id}`,
            shared.profile,
            { service: shared.account, backup: shared.account },
          );
          expect(selected.status, JSON.stringify(selected.body)).toBe(200);
          yield* settled(pair.id, shared.profile);
          const renewed = (yield* refreshes) + 1;
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${pair.id}/tools/call`,
            { profile: shared.profile, tool: "queries.read", input: {} },
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(yield* body(Read, response)).toEqual({
            service: presented(renewed),
            backup: presented(renewed),
          });
          expect(yield* refreshes).toBe(renewed);
        }

        const transient: ReadonlyArray<{
          readonly failure: RefreshFailure;
          readonly reason: "service_unavailable" | "incompatible_response";
          readonly status?: number;
          readonly providerError?: string;
        }> = [
          { failure: "unavailable", reason: "service_unavailable", status: 503 },
          { failure: "rate_limited", reason: "service_unavailable", status: 429 },
          {
            failure: "server_error",
            reason: "service_unavailable",
            status: 400,
            providerError: "server_error",
          },
          {
            failure: "temporarily_unavailable",
            reason: "service_unavailable",
            status: 400,
            providerError: "temporarily_unavailable",
          },
          { failure: "connection_reset", reason: "service_unavailable" },
          { failure: "malformed", reason: "incompatible_response", status: 200 },
        ];
        for (const scenario of transient) {
          yield* issuer.configure({ tokenError: refreshFailures[scenario.failure] });
          const before = yield* refreshes;
          const failed = yield* read(renewing.profile);
          expect(failed.status, `${scenario.failure}: ${JSON.stringify(failed.body)}`).toBe(502);
          expect(yield* body(Failure, failed), scenario.failure).toMatchObject({
            _tag: "OAuthRenewalFailed",
            account: renewing.account,
            reason: scenario.reason,
            cause: {
              stage: "refresh",
              ...(scenario.status === undefined ? {} : { status: scenario.status }),
              ...(scenario.providerError === undefined
                ? {}
                : { providerError: scenario.providerError }),
            },
          });
          // A dropped connection has no response status to record.
          if (scenario.status === undefined)
            expect((yield* body(Failure, failed)).cause?.status, scenario.failure).toBeUndefined();
          assertPrivate(failed.body);
          // One attempt per call; the claim is released rather than retried or abandoned.
          expect(yield* refreshes, scenario.failure).toBe(before + 1);
          if (scenario.failure === "unavailable") {
            const trace = yield* spans;
            expect(
              trace.data.find(
                ({ span }) =>
                  span.operationName === "oauth.resolve" &&
                  span.tags["oauth.renewal.outcome"] !== undefined,
              )?.span.tags,
            ).toMatchObject({
              "oauth.provider.id": provider,
              "oauth.renewal.outcome": "service_unavailable",
            });
            expect(
              trace.data.find(({ span }) => span.operationName === "oauth.refresh")?.span.tags,
            ).toMatchObject({ "oauth.provider.id": provider, "oauth.stage": "refresh" });
            assertPrivate(trace);
            yield* evidence.json("refresh-unavailable-trace.json", trace);
          }
          // The saved refresh token still works once the service recovers.
          yield* issuer.configure({ tokenError: null });
          yield* expectRead(renewing.profile, before + 2);
        }

        // A renewal that states no lifetime, by omitting it or giving zero, keeps its token
        // rather than renewing on every call.
        for (const lifetime of [0, null] as const) {
          yield* issuer.configure({ expiresIn: 20 });
          const unstated = yield* connect(`Synthetic ${lifetime ?? "omitted"} lifetime account`);
          yield* issuer.configure({ expiresIn: lifetime });
          const renewed = (yield* refreshes) + 1;
          yield* expectRead(unstated.profile, renewed);
          yield* expectRead(unstated.profile, renewed);
          expect(yield* refreshes, `expires_in ${lifetime}`).toBe(renewed);
        }
        // Without a refresh token, a zero lifetime does not demand an immediate reconnect.
        yield* issuer.configure({ refreshTokens: false, expiresIn: 0 });
        const unrenewable = yield* connect("Synthetic zero-lifetime account");
        yield* expectRead(unrenewable.profile, 0);
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });

        // A refused grant needs a new sign-in, and the host stops presenting it.
        const refused = yield* connect("Synthetic refused account");
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const beforeRefusal = yield* refreshes;
        const rejected = yield* read(refused.profile);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(yield* body(Failure, rejected)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: refused.account,
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        });
        assertPrivate(rejected.body);
        const refusal = yield* spans;
        expect(
          refusal.data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.reconnect.reason"] !== undefined,
          )?.span.tags,
        ).toMatchObject({
          "oauth.provider.id": provider,
          "oauth.renewal.outcome": "reconnect",
          "oauth.reconnect.reason": "renewal_refused",
          "oauth.error.stage": "refresh",
          "oauth.error.provider_code": "invalid_grant",
          "http.response.status_code": "400",
        });
        assertPrivate(refusal);
        yield* evidence.json("refresh-refused-trace.json", refusal);
        yield* issuer.configure({ tokenError: null });
        const again = yield* read(refused.profile);
        expect(again.status, JSON.stringify(again.body)).toBe(409);
        expect(yield* refreshes).toBe(beforeRefusal + 1);
      }),
    ),
  );
});
