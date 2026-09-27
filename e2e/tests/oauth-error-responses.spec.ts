/** Drive real sign-ins against a loopback issuer that answers with standard and nonstandard errors. */
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
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  recovery: Schema.optional(Schema.Struct({ instructions: Schema.String })),
});
const Echo = Schema.Struct({ authorization: Schema.NullOr(Schema.String) });

/** An authorization-code app whose only query presents the account's token to the issuer. */
const resourceAppFiles = (name: string, origin: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, oauth2, query, object } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(origin)}, scopes: ["openid", "read"] }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({ queries: { read: query({ input: object({}) }, async ({ fetch }) => {
  const result = await fetch(${JSON.stringify(`${origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
  return result.json();
}) } }));
`,
  },
];

layer(HostedLive, { excludeTestServices: true })("OAuth error responses", (it) => {
  it.effect(scenarios.oauthErrorResponses.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const standard = {
          scopes: ["read"],
          includeIdToken: false,
          idTokenAlgorithms: ["ES256"],
          idTokenAlgorithm: "ES256",
          tokenError: null,
          tokenType: "Bearer",
          authorizeError: null,
          callbackIssuer: null,
          challengeScheme: "Bearer",
          bearerMethods: null,
          refreshTokens: false,
          expiresIn: 3600,
          refreshSubject: "synthetic-subject",
          refreshedExpiresIn: null,
        } as const;

        /** Deploy an app, sign in through the issuer and complete the callback. */
        const signIn = (
          files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
          name: string,
          configuration: Parameters<typeof issuer.configure>[0],
        ) =>
          Effect.gen(function* () {
            yield* issuer.configure({ ...standard, ...configuration });
            const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files,
            });
            expect(imported.status, JSON.stringify(imported.body)).toBe(200);
            const app = yield* body(Resource, imported);
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
              { method: "oauth", label: "Synthetic error account" },
            );
            expect(started.status, `${name}: ${JSON.stringify(started.body)}`).toBe(200);
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
            const exchanges = (yield* issuer.metrics).tokenExchanges;
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            if (completed.status === 200) {
              const account = yield* body(Resource, completed);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                  .pipe(Effect.orDie),
              );
            }
            return {
              app,
              profile,
              completed,
              failure: yield* body(Failure, completed),
              exchanged: (yield* issuer.metrics).tokenExchanges - exchanges,
            };
          });

        const mcp = (name: string) => {
          const unique = `${name} ${randomUUID().slice(0, 8)}`;
          return [oauthMcpAppFiles(unique, `${issuer.origin}/mcp`), unique] as const;
        };

        // Token endpoint errors are classified by their RFC 6749 §5.2 body, whatever the status.
        const tokenErrors: ReadonlyArray<{
          readonly name: string;
          readonly tokenError: {
            readonly status: number;
            readonly body: object;
            readonly challenge?: string;
          };
          readonly reason: string;
          readonly evidence: string;
        }> = [
          {
            name: "HTTP 200 invalid_grant",
            tokenError: { status: 200, body: { error: "invalid_grant" } },
            reason: "authorization_code_rejected",
            evidence: "HTTP 200, provider error invalid_grant",
          },
          {
            name: "HTTP 200 invalid_client",
            tokenError: {
              status: 200,
              body: { error: "invalid_client", error_description: "PRIVATE_PROVIDER_ERROR" },
            },
            reason: "invalid_client",
            evidence: "HTTP 200, provider error invalid_client",
          },
          {
            name: "HTTP 200 nonstandard error",
            tokenError: { status: 200, body: { ok: false, error: "private_nonstandard_code" } },
            reason: "exchange_failed",
            evidence: "HTTP 200.",
          },
          {
            name: "HTTP 401 Basic challenge",
            tokenError: {
              status: 401,
              body: { error: "invalid_client" },
              challenge: 'Basic realm="synthetic"',
            },
            reason: "invalid_client",
            evidence: "HTTP 401, provider error invalid_client",
          },
        ];
        for (const scenario of tokenErrors) {
          const [files, name] = mcp(scenario.name);
          const result = yield* signIn(files, name, { tokenError: scenario.tokenError });
          expect(result.completed.status, scenario.name).toBe(400);
          expect(result.failure, scenario.name).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: scenario.reason,
          });
          expect(result.failure.recovery?.instructions, scenario.name).toContain(scenario.evidence);
          expect(result.exchanged, scenario.name).toBe(1);
          const serialized = JSON.stringify(result.completed.body);
          expect(serialized).not.toContain("PRIVATE_PROVIDER_ERROR");
          expect(serialized).not.toContain("private_nonstandard_code");
        }

        // Callback errors keep their RFC 6749 §4.1.2.1 meaning, after the RFC 9207 issuer check.
        // A callback from another issuer is an issuer mismatch, whatever error it carries. Only
        // access_denied is a cancellation; other and unknown codes are authorization errors.
        const callbackErrors: ReadonlyArray<{
          readonly error: string;
          readonly reason: string;
          readonly callbackIssuer?: string;
        }> = [
          { error: "access_denied", reason: "denied" },
          { error: "invalid_scope", reason: "invalid_scope" },
          { error: "server_error", reason: "service_unavailable" },
          { error: "temporarily_unavailable", reason: "service_unavailable" },
          { error: "invalid_request", reason: "authorization_rejected" },
          { error: "unsupported_response_type", reason: "authorization_rejected" },
          { error: "unauthorized_client", reason: "invalid_client" },
          { error: "private_nonstandard_code", reason: "authorization_rejected" },
          {
            error: "access_denied",
            reason: "issuer_mismatch",
            callbackIssuer: "https://issuer.invalid",
          },
        ];
        for (const scenario of callbackErrors) {
          const label = `Callback ${scenario.error}${scenario.callbackIssuer === undefined ? "" : " from another issuer"}`;
          const [files, name] = mcp(label);
          const result = yield* signIn(files, name, {
            authorizeError: scenario.error,
            ...(scenario.callbackIssuer === undefined
              ? {}
              : { callbackIssuer: scenario.callbackIssuer }),
          });
          expect(result.completed.status, label).toBe(400);
          expect(result.failure, label).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: scenario.reason,
          });
          expect(result.exchanged, label).toBe(0);
          expect(JSON.stringify(result.completed.body)).not.toContain("private_nonstandard_code");
        }

        // A resource that advertised Bearer accepts its service's nonstandard token type.
        const tokenTypes: ReadonlyArray<{
          readonly name: string;
          readonly tokenType: string;
          readonly challengeScheme: string;
          readonly bearerMethods: readonly string[] | null;
          readonly reason: string | undefined;
        }> = [
          {
            name: "Nonstandard type, Bearer challenge",
            tokenType: "user",
            challengeScheme: "Bearer",
            bearerMethods: null,
            reason: undefined,
          },
          {
            name: "Nonstandard type, Bearer metadata",
            tokenType: "user",
            challengeScheme: "DPoP",
            bearerMethods: ["header"],
            reason: undefined,
          },
          {
            name: "Nonstandard type, no Bearer advertised",
            tokenType: "user",
            challengeScheme: "DPoP",
            bearerMethods: null,
            reason: "incompatible_response",
          },
          {
            name: "DPoP-bound token",
            tokenType: "DPoP",
            challengeScheme: "Bearer",
            bearerMethods: null,
            reason: "unsupported",
          },
        ];
        for (const scenario of tokenTypes) {
          const [files, name] = mcp(scenario.name);
          const result = yield* signIn(files, name, scenario);
          expect(
            result.completed.status,
            `${scenario.name}: ${JSON.stringify(result.failure)}`,
          ).toBe(scenario.reason === undefined ? 200 : 400);
          if (scenario.reason !== undefined)
            expect(result.failure, scenario.name).toMatchObject({
              _tag: "OAuthCompletionFailed",
              reason: scenario.reason,
            });
          expect(result.exchanged, scenario.name).toBe(1);
        }

        // An unsigned ID token is rejected even when the service advertises `none`.
        {
          const [files, name] = mcp("Unsigned ID token");
          const result = yield* signIn(files, name, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            idTokenAlgorithms: ["ES256", "none"],
            idTokenAlgorithm: "none",
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(400);
          expect(result.failure).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: "incompatible_response",
          });
          expect(result.failure.recovery?.instructions).toContain("response field jwt_alg");
        }

        // A refreshed ID token must keep the subject the first one identified.
        for (const scenario of [
          { name: "Same subject", subject: "synthetic-subject", renewed: true },
          { name: "Different subject", subject: "synthetic-other-subject", renewed: false },
        ]) {
          const unique = `${scenario.name} ${randomUUID().slice(0, 8)}`;
          const result = yield* signIn(resourceAppFiles(unique, issuer.origin), unique, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            refreshTokens: true,
            // Inside the host's refresh window, so the first tool call renews the grant.
            expiresIn: 10,
            // Renewed tokens stay valid, so one tool call renews once.
            refreshedExpiresIn: 3600,
            refreshSubject: scenario.subject,
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(200);
          const refreshes = (yield* issuer.metrics).refreshes;
          const read = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${result.app.id}/tools/call`,
            { profile: result.profile.id, tool: "queries.read", input: {} },
          );
          expect((yield* issuer.metrics).refreshes, scenario.name).toBe(refreshes + 1);
          if (scenario.renewed) {
            expect(read.status, JSON.stringify(read.body)).toBe(200);
            expect((yield* body(Echo, read)).authorization).toMatch(
              /^Bearer synthetic-refreshed-token-\d+$/,
            );
          } else {
            expect(read.status, JSON.stringify(read.body)).not.toBe(200);
            expect(JSON.stringify(read.body)).toContain("OAuthReconnectRequired");
          }
        }
      }),
    ),
  );
});
