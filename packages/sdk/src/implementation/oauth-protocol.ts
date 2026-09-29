/** OAuth wire protocol. Effect owns transport and cancellation; oauth4webapi validates responses. */
import { parseDestination } from "@executor-js/utils/url-policy";
import { Effect, Encoding, Schema } from "effect";
import { captureTelemetry } from "@executor-js/telemetry";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import * as oauth from "oauth4webapi";
import {
  OAuthProviderErrorCode,
  OAuthResponseField,
  OAuthResource,
  OAuthServer,
  OAuthTokenServer,
  type OAuthConfidentialRegistration,
  OAuthRegistration,
  type OAuthOptions,
  type OAuthClientAuth,
} from "../contracts/oauth.ts";
import type { ProviderAuthMethod } from "../contracts/provider.ts";
import { probeOAuthChallenge } from "./oauth-probe.ts";

const ProtocolCode = Schema.Literals([
  oauth.WWW_AUTHENTICATE_CHALLENGE,
  oauth.RESPONSE_BODY_ERROR,
  oauth.UNSUPPORTED_OPERATION,
  oauth.AUTHORIZATION_RESPONSE_ERROR,
  oauth.PARSE_ERROR,
  oauth.INVALID_RESPONSE,
  oauth.INVALID_REQUEST,
  oauth.RESPONSE_IS_NOT_JSON,
  oauth.RESPONSE_IS_NOT_CONFORM,
  oauth.HTTP_REQUEST_FORBIDDEN,
  oauth.REQUEST_PROTOCOL_FORBIDDEN,
  oauth.JWT_TIMESTAMP_CHECK,
  oauth.JWT_CLAIM_COMPARISON,
  oauth.JSON_ATTRIBUTE_COMPARISON,
  oauth.KEY_SELECTION,
  oauth.MISSING_SERVER_METADATA,
  oauth.INVALID_SERVER_METADATA,
  "schema_decode",
  "timeout",
]);
/** Private, sanitized protocol failure. Never retain a response, request, or thrown library error. */
export class OAuthProtocolFailed extends Schema.TaggedError<OAuthProtocolFailed>()(
  "OAuthProtocolFailed",
  {
    code: Schema.optional(ProtocolCode),
    status: Schema.optional(Schema.Int),
    providerError: Schema.optional(OAuthProviderErrorCode),
    field: Schema.optional(OAuthResponseField),
    reason: Schema.Literals([
      "request",
      "invalid_grant",
      "invalid_client",
      "invalid_response",
      "metadata_missing",
      "destination_blocked",
      "resource_mismatch",
      "unsupported",
      "subject_changed",
    ]),
  },
) {}

/** RFC 6749 §5.2 error codes map to reasons; unknown codes are dropped from the recorded evidence. */
const errorResponse = (status: number, error: string) =>
  new OAuthProtocolFailed({
    code: oauth.RESPONSE_BODY_ERROR,
    status,
    ...(Schema.is(OAuthProviderErrorCode)(error) ? { providerError: error } : {}),
    reason:
      error === "invalid_grant"
        ? "invalid_grant"
        : error === "invalid_client"
          ? "invalid_client"
          : "request",
  });

const failure = (error: unknown): OAuthProtocolFailed => {
  if (Schema.is(OAuthProtocolFailed)(error)) return error;
  const libraryError =
    error instanceof oauth.OperationProcessingError ||
    error instanceof oauth.ResponseBodyError ||
    error instanceof oauth.WWWAuthenticateChallengeError ||
    error instanceof oauth.UnsupportedOperationError ||
    error instanceof oauth.AuthorizationResponseError;
  const code = libraryError && Schema.is(ProtocolCode)(error.code) ? error.code : undefined;
  const status =
    error instanceof oauth.ResponseBodyError || error instanceof oauth.WWWAuthenticateChallengeError
      ? error.status
      : error instanceof oauth.OperationProcessingError && error.cause instanceof Response
        ? error.cause.status
        : undefined;
  const providerError =
    (error instanceof oauth.ResponseBodyError ||
      error instanceof oauth.AuthorizationResponseError) &&
    Schema.is(OAuthProviderErrorCode)(error.error)
      ? error.error
      : undefined;
  // Match library-owned validation labels; never record its message, cause, expected value or body.
  const fieldValue =
    error instanceof oauth.OperationProcessingError
      ? error.message === 'unexpected JWT "alg" header parameter'
        ? "jwt_alg"
        : error.message === 'unexpected "iss" (issuer) response parameter value' ||
            error.message === 'response parameter "iss" (issuer) missing'
          ? "issuer"
          : /^"response" body "([a-z_]+)" property/.exec(error.message)?.[1]
      : undefined;
  return new OAuthProtocolFailed({
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(providerError === undefined ? {} : { providerError }),
    ...(Schema.is(OAuthResponseField)(fieldValue) ? { field: fieldValue } : {}),
    reason:
      error instanceof oauth.ResponseBodyError && error.error === "invalid_grant"
        ? "invalid_grant"
        : error instanceof oauth.ResponseBodyError && error.error === "invalid_client"
          ? "invalid_client"
          : error instanceof oauth.OperationProcessingError || error instanceof SyntaxError
            ? "invalid_response"
            : "request",
  });
};

/**
 * The endpoint answered with an OAuth error: an error body (RFC 6749 §5.2) or a client
 * authentication challenge. Other failures carry no statement about the grant.
 */
export const isOAuthErrorResponse = (error: OAuthProtocolFailed) =>
  error.code === oauth.RESPONSE_BODY_ERROR || error.code === oauth.WWW_AUTHENTICATE_CHALLENGE;

const observeFailure = (error: OAuthProtocolFailed) =>
  Effect.annotateCurrentSpan({
    "oauth.error.reason": error.reason,
    ...(error.code === undefined ? {} : { "oauth.error.code": error.code }),
    ...(error.status === undefined ? {} : { "http.response.status_code": error.status }),
    ...(error.providerError === undefined
      ? {}
      : { "oauth.error.provider_code": error.providerError }),
    ...(error.field === undefined ? {} : { "oauth.error.field": error.field }),
  });
const protocolStage =
  (
    stage:
      | "discover"
      | "register"
      | "authorize"
      | "exchange"
      | "clientCredentials"
      | "refresh"
      | "revoke",
  ) =>
  <A, R>(program: Effect.Effect<A, OAuthProtocolFailed, R>) =>
    program.pipe(
      Effect.tapError(observeFailure),
      Effect.withSpan(`oauth.${stage}`, { attributes: { "oauth.stage": stage } }),
    );

/** Rehydrate mutable protocol arrays from the immutable storage contract. */
const metadata = (server: OAuthTokenServer): oauth.AuthorizationServer => ({
  issuer: server.issuer,
  ...(server.authorization_endpoint === undefined
    ? {}
    : { authorization_endpoint: server.authorization_endpoint }),
  token_endpoint: server.token_endpoint,
  ...(server.jwks_uri === undefined ? {} : { jwks_uri: server.jwks_uri }),
  // Unsigned ID tokens are never accepted, even when advertised. Without metadata, oauth4webapi
  // requires OIDC Registration's RS256 default.
  ...(server.id_token_signing_alg_values_supported === undefined
    ? {}
    : {
        id_token_signing_alg_values_supported: server.id_token_signing_alg_values_supported.filter(
          (alg) => alg.toLowerCase() !== "none",
        ),
      }),
  ...(server.registration_endpoint === undefined
    ? {}
    : { registration_endpoint: server.registration_endpoint }),
  ...(server.revocation_endpoint === undefined
    ? {}
    : { revocation_endpoint: server.revocation_endpoint }),
  ...(server.authorization_response_iss_parameter_supported === undefined
    ? {}
    : {
        authorization_response_iss_parameter_supported:
          server.authorization_response_iss_parameter_supported,
      }),
  ...(server.code_challenge_methods_supported === undefined
    ? {}
    : { code_challenge_methods_supported: [...server.code_challenge_methods_supported] }),
  ...(server.token_endpoint_auth_methods_supported === undefined
    ? {}
    : { token_endpoint_auth_methods_supported: [...server.token_endpoint_auth_methods_supported] }),
});

const basicAuth =
  (secret: string, encode: (value: string) => string): oauth.ClientAuth =>
  (_server, registered, _body, headers) => {
    headers.set(
      "authorization",
      `Basic ${Encoding.encodeBase64(new TextEncoder().encode(`${encode(registered.client_id)}:${encode(secret)}`))}`,
    );
  };

/**
 * RFC 6749 section 2.3.1 form-encodes Basic credentials. The URL Standard's serializer leaves
 * letters, digits and `*-._` as they are. Servers that decode read the same values, and
 * Doorkeeper, which compares the header literally, accepts the IDs and secrets it issues.
 */
const formEncode = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);

const clientAuth = (client: OAuthRegistration) => {
  switch (client.token_endpoint_auth_method) {
    case "none":
      return oauth.None();
    case "client_secret_basic":
      return basicAuth(client.client_secret, formEncode);
    case "client_secret_basic_raw":
      return basicAuth(client.client_secret, (value) => value);
    case "client_secret_post":
      return oauth.ClientSecretPost(client.client_secret);
  }
};

/** Fill a missing client_secret_expires_at with RFC 7591's "does not expire" value. */
const registrationBody = (text: string) => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  return typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof Reflect.get(parsed, "client_secret") === "string" &&
    Reflect.get(parsed, "client_secret") !== "" &&
    (Reflect.get(parsed, "client_secret_expires_at") ?? undefined) === undefined
    ? JSON.stringify({ ...parsed, client_secret_expires_at: 0 })
    : text;
};

/** Read a copy of a token response to learn whether the service returned an ID token. */
const hasIdToken = async (response: Response) => {
  if (!response.ok) return false;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && Reflect.get(body, "id_token") !== undefined;
  } catch {
    return false;
  }
};

/**
 * An ID token's `iss` cannot be checked against a derived issuer. Executor never reads ID tokens,
 * so drop one it cannot validate instead of rejecting the tokens beside it.
 */
const withoutIdToken = async (response: Response) => {
  if (!(await hasIdToken(response))) return response;
  const body: unknown = await response.json();
  return new Response(
    JSON.stringify(
      Object.fromEntries(Object.entries(body as object).filter(([key]) => key !== "id_token")),
    ),
    { status: response.status, headers: response.headers },
  );
};

/** Read a copy of a JSON object response body, or undefined when it is not one. */
const jsonObject = async (response: Response) => {
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
};

/**
 * RFC 6749 §5.2: a JSON object with an `error` code and no access token is an error response,
 * whatever its HTTP status. Some services send it with HTTP 200; with a 401 WWW-Authenticate
 * challenge, oauth4webapi reports the challenge before reading the body.
 */
const tokenResponse = async (response: Response) => {
  const body = await jsonObject(response);
  const error = body === undefined ? undefined : Reflect.get(body, "error");
  if (
    body === undefined ||
    typeof error !== "string" ||
    error === "" ||
    Reflect.get(body, "access_token") !== undefined
  )
    return response;
  throw errorResponse(response.status, error);
};

const isLowercase = (value: string): value is Lowercase<string> => value === value.toLowerCase();

/**
 * Executor sends every access token as a Bearer token and never creates DPoP proofs (RFC 9449).
 * A resource that advertised Bearer accepts its tokens as Bearer whatever `token_type` says;
 * without that advertisement, oauth4webapi accepts only `bearer`.
 */
const tokenTypes = async (
  response: Response,
  bearerResource: boolean | undefined,
): Promise<oauth.RecognizedTokenTypes> => {
  const body = bearerResource === true ? await jsonObject(response) : undefined;
  const received = body === undefined ? undefined : Reflect.get(body, "token_type");
  const type = typeof received === "string" ? received.toLowerCase() : undefined;
  return {
    dpop: () => {
      throw new OAuthProtocolFailed({ reason: "unsupported", field: "token_type" });
    },
    ...(type === undefined || type === "bearer" || type === "dpop" || !isLowercase(type)
      ? {}
      : { [type]: () => undefined }),
  };
};

/** The validated ID token's subject, when the token response carried one. */
export const idTokenSubject = (tokens: oauth.TokenEndpointResponse) => {
  const subject = oauth.getValidatedIdTokenClaims(tokens)?.sub;
  return subject === "" ? undefined : subject;
};

/** Resolve protocol operations against one host-supplied Effect HTTP client. */
export const makeOAuthProtocol = (options: OAuthOptions) => {
  // This callback is the external library boundary, not an internal Promise implementation.
  const transport =
    (telemetry: Effect.Success<typeof captureTelemetry>, received: (status: number) => void) =>
    (url: string, init: oauth.CustomFetchOptions<string, BodyInit | undefined>) =>
      Effect.runPromiseWith(telemetry.context)(
        Effect.gen(function* () {
          // Enforce host policy on every request, including discovered endpoints and saved grants.
          const destination = parseDestination(url, options.urlPolicy);
          if (destination === undefined)
            return yield* new OAuthProtocolFailed({ reason: "destination_blocked" });
          const request = yield* Effect.try({
            try: () =>
              HttpClientRequest.fromWeb(
                new Request(destination, {
                  method: init.method,
                  headers: init.headers,
                  ...(init.body === undefined ? {} : { body: init.body }),
                }),
              ),
            catch: failure,
          });
          const response = yield* options.httpClient.execute(request);
          yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
          received(response.status);
          const body = yield* response.arrayBuffer.pipe(Effect.withSpan("oauth.response.read"));
          return new Response(body, { status: response.status, headers: response.headers });
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(failure),
        ),
        init.signal === undefined ? {} : { signal: init.signal },
      );
  const requestOptions = (
    signal: AbortSignal,
    telemetry: Effect.Success<typeof captureTelemetry>,
    received: (status: number) => void,
  ) => ({
    [oauth.customFetch]: transport(telemetry, received),
    [oauth.allowInsecureRequests]: true,
    signal,
  });
  const request = <A>(run: (settings: ReturnType<typeof requestOptions>) => Promise<A>) =>
    Effect.gen(function* () {
      const telemetry = yield* captureTelemetry;
      // The last response status tells a rejection (4xx) from a response we could not use (2xx).
      let status: number | undefined;
      return yield* Effect.tryPromise({
        try: (signal) =>
          run(
            requestOptions(signal, telemetry, (received) => {
              status = received;
            }),
          ),
        catch: (error) => {
          const failed = failure(error);
          return failed.status !== undefined || status === undefined
            ? failed
            : new OAuthProtocolFailed({
                reason: failed.reason,
                status,
                ...(failed.code === undefined ? {} : { code: failed.code }),
                ...(failed.providerError === undefined
                  ? {}
                  : { providerError: failed.providerError }),
                ...(failed.field === undefined ? {} : { field: failed.field }),
              });
        },
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new OAuthProtocolFailed({ reason: "request", code: "timeout" })
          : error,
      ),
      Effect.tapError(observeFailure),
      Effect.withSpan("oauth.request"),
    );
  const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        () => new OAuthProtocolFailed({ reason: "invalid_response", code: "schema_decode" }),
      ),
    );

  const clientMethod = (server: OAuthTokenServer, configured?: OAuthClientAuth) => {
    const supported = server.token_endpoint_auth_methods_supported;
    const method =
      configured ??
      (supported?.includes("none")
        ? "none"
        : supported?.includes("client_secret_post") && !supported.includes("client_secret_basic")
          ? "client_secret_post"
          : "client_secret_basic");
    const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
    return supported !== undefined && !supported.includes(advertised)
      ? Effect.fail(new OAuthProtocolFailed({ reason: "invalid_response" }))
      : Effect.succeed(method);
  };

  const discoveryResponse = (response: Response) => {
    if (response.status === 404 || response.status === 410)
      throw new OAuthProtocolFailed({ reason: "metadata_missing" });
    if (response.status === 429 || response.status >= 500)
      throw new OAuthProtocolFailed({ reason: "request" });
    if (response.status !== 200) throw new OAuthProtocolFailed({ reason: "invalid_response" });
    return response;
  };

  const discoverIssuer = (issuer: URL) =>
    request(async (settings) => {
      let response = await oauth.discoveryRequest(issuer, { ...settings, algorithm: "oauth2" });
      if (response.status === 404)
        response = await oauth.discoveryRequest(issuer, { ...settings, algorithm: "oidc" });
      // A well-known URL that refuses the request serves no metadata. Atlassian's MCP endpoint
      // answers the appended OpenID path with 401.
      if (response.status >= 400 && response.status < 500 && response.status !== 429)
        throw new OAuthProtocolFailed({ reason: "metadata_missing" });
      return oauth.processDiscoveryResponse(issuer, discoveryResponse(response));
    }).pipe(Effect.flatMap((server) => decode(OAuthTokenServer, server)));

  const secureUrl = (value: string) => {
    const url = parseDestination(value, options.urlPolicy);
    return url === undefined
      ? Effect.fail(new OAuthProtocolFailed({ reason: "destination_blocked" }))
      : Effect.succeed(url);
  };

  const discoverResource = (endpoint: URL) =>
    Effect.gen(function* () {
      // Inspect only headers: a successful MCP GET may open an endless SSE stream.
      const challenge = yield* probeOAuthChallenge(endpoint, options.httpClient).pipe(
        Effect.flatMap((response) =>
          response.status === 429 || response.status >= 500
            ? Effect.fail(new OAuthProtocolFailed({ reason: "request" }))
            : Effect.succeed(response),
        ),
        Effect.mapError(failure),
      );
      const advertised = challenge.resourceMetadata;
      const metadataUrl = advertised === undefined ? undefined : yield* secureUrl(advertised);
      const document = yield* request(async (settings) => {
        let response =
          metadataUrl === undefined
            ? await oauth.resourceDiscoveryRequest(endpoint, settings)
            : await settings[oauth.customFetch](metadataUrl.href, {
                method: "GET",
                body: undefined,
                headers: { accept: "application/json" },
                redirect: "manual",
                signal: settings.signal,
              });
        if (metadataUrl === undefined && response.status === 404 && endpoint.pathname !== "/") {
          response = await settings[oauth.customFetch](
            new URL("/.well-known/oauth-protected-resource", endpoint).href,
            {
              method: "GET",
              body: undefined,
              headers: { accept: "application/json" },
              redirect: "manual",
              signal: settings.signal,
            },
          );
        }
        if (metadataUrl === undefined && response.status === 404) return undefined;
        const document: unknown = await discoveryResponse(response).json();
        return document;
      });
      if (document === undefined) return { found: undefined, bearer: challenge.bearer };
      const found = yield* decode(OAuthResource, document);
      const resource = yield* secureUrl(found.resource);
      // A resource can cover /mcp from the origin root, but cannot name a sibling
      // service or a different host. Preserve its exact advertised identifier.
      const prefix = resource.pathname.endsWith("/") ? resource.pathname : resource.pathname + "/";
      if (
        resource.origin !== endpoint.origin ||
        (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))
      ) {
        return yield* new OAuthProtocolFailed({ reason: "resource_mismatch" });
      }
      return {
        found,
        bearer: challenge.bearer || (found.bearer_methods_supported?.length ?? 0) > 0,
      };
    });

  return {
    discover: (method: Extract<ProviderAuthMethod, { type: "oauth2" }>) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.gen(function* () {
          if (method.discover === undefined)
            return {
              server: yield* decode(OAuthTokenServer, {
                ...("issuer" in method && method.issuer !== undefined
                  ? { issuer: method.issuer }
                  : { issuer: new URL(method.tokenUrl).origin, issuer_derived: true }),
                ...(method.authorizationUrl === undefined
                  ? {}
                  : { authorization_endpoint: method.authorizationUrl }),
                token_endpoint: method.tokenUrl,
                ...(method.revocationUrl === undefined
                  ? {}
                  : { revocation_endpoint: method.revocationUrl }),
              }),
              scopes: [...method.scopes],
              // Undeclared means the client decides: a secret uses RFC 7591's client_secret_basic default.
              tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
              ...(method.resource == null ? {} : { resource: method.resource }),
            };
          const resource = yield* secureUrl(method.discover);
          const { found, bearer } = yield* discoverResource(resource);
          const issuer = found === undefined ? resource.href : found.authorization_servers[0];
          if (issuer === undefined)
            return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
          const issuerUrl = yield* secureUrl(issuer);
          // Without protected-resource metadata, MCP's earlier authorization rules use the
          // server's origin as the authorization base. Atlassian publishes metadata only there.
          const server = yield* found === undefined && issuerUrl.pathname !== "/"
            ? discoverIssuer(issuerUrl).pipe(
                // Only missing metadata falls back. Served metadata that is invalid or names another
                // issuer is a failure, never a reason to try a different issuer.
                Effect.catchIf(
                  (error) => error.reason === "metadata_missing",
                  () => discoverIssuer(new URL(issuerUrl.origin)),
                ),
              )
            : discoverIssuer(issuerUrl);
          const scopes = new Set(method.scopes ?? found?.scopes_supported ?? []);
          if (
            method.grant !== "client_credentials" &&
            method.scopes === undefined &&
            server.scopes_supported?.includes("offline_access")
          )
            scopes.add("offline_access");
          const resourceIndicator =
            method.resource === undefined ? found?.resource : method.resource;
          return {
            server,
            scopes: [...scopes],
            // RFC 8414 lists what the server accepts; which one applies is the client's property.
            // A server open to public and secret clients leaves an undeclared choice to the client.
            ...(method.tokenEndpointAuthMethod === undefined &&
            server.token_endpoint_auth_methods_supported?.includes("none") &&
            server.token_endpoint_auth_methods_supported.some(
              (m) => m === "client_secret_basic" || m === "client_secret_post",
            )
              ? {}
              : {
                  tokenEndpointAuthMethod: yield* clientMethod(
                    server,
                    method.tokenEndpointAuthMethod,
                  ),
                }),
            ...(resourceIndicator == null ? {} : { resource: resourceIndicator }),
            ...(bearer ? { bearerResource: true as const } : {}),
          };
        });
        if (method.grant === "client_credentials")
          return { ...resolved, grant: "client_credentials" as const };
        return {
          ...resolved,
          grant: "authorization_code" as const,
          server: yield* decode(OAuthServer, resolved.server),
          ...(method.authorizationParams === undefined
            ? {}
            : { authorizationParams: method.authorizationParams }),
        };
      }).pipe(protocolStage("discover")),
    register: (
      server: OAuthServer,
      redirectUri: string,
      scopes: readonly string[],
      configured?: OAuthClientAuth,
    ) =>
      Effect.gen(function* () {
        const method = yield* clientMethod(server, configured);
        const advertised = method === "client_secret_basic_raw" ? "client_secret_basic" : method;
        const registered = yield* request(async (settings) => {
          const response = await oauth.dynamicClientRegistrationRequest(
            metadata(server),
            {
              client_name: options.clientName,
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: advertised,
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
            },
            settings,
          );
          if (response.status !== 200 && response.status !== 201)
            return oauth.processDynamicClientRegistrationResponse(response);
          // Some providers use 200 instead of RFC 7591's 201, and some issue a secret without
          // client_secret_expires_at. Normalize only the status and that missing expiry, which
          // RFC 7591 defines as 0 for a secret that does not expire. oauth4webapi still
          // validates the content type, JSON and every other registration field.
          // The transport span retains the provider's original status.
          const text = await response.text();
          return oauth.processDynamicClientRegistrationResponse(
            new Response(registrationBody(text), { status: 201, headers: response.headers }),
          );
        });
        const issued = registered.token_endpoint_auth_method;
        if (issued === undefined || issued === advertised)
          return yield* decode(OAuthRegistration, {
            ...registered,
            token_endpoint_auth_method: method,
          });
        // RFC 7591 section 3.2.1: the server may replace requested metadata, and the client
        // uses what was issued. Vercel registers a public client when asked for a secret one.
        // A method the app configured is a requirement, so a replacement there is a mismatch.
        if (configured !== undefined)
          return yield* new OAuthProtocolFailed({ reason: "invalid_response" });
        return yield* decode(OAuthRegistration, registered);
      }).pipe(protocolStage("register")),
    authorize: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      redirectUri: string;
      scopes: readonly string[];
      resource?: string;
      authorizationParams?: Readonly<Record<string, string>>;
    }) =>
      Effect.gen(function* () {
        const state = yield* Effect.sync(oauth.generateRandomState);
        const verifier = yield* Effect.sync(oauth.generateRandomCodeVerifier);
        const nonce = input.scopes.includes("openid")
          ? yield* Effect.sync(oauth.generateRandomNonce)
          : undefined;
        const challenge = yield* request(() => oauth.calculatePKCECodeChallenge(verifier));
        const url = new URL(input.server.authorization_endpoint);
        // Declared extras go first so the protocol parameters below always win.
        for (const [key, value] of Object.entries(input.authorizationParams ?? {}))
          url.searchParams.set(key, value);
        for (const [key, value] of Object.entries({
          response_type: "code",
          client_id: input.client.client_id,
          redirect_uri: input.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }))
          url.searchParams.set(key, value);
        if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
        if (input.resource !== undefined) url.searchParams.set("resource", input.resource);
        if (nonce !== undefined) url.searchParams.set("nonce", nonce);
        return {
          state,
          verifier,
          authorizationUrl: url.href,
          ...(nonce === undefined ? {} : { nonce }),
        };
      }).pipe(protocolStage("authorize")),
    /**
     * Validate the authorization response before any token request: its state, its RFC 9207
     * issuer, and then any RFC 6749 §4.1.2.1 `error`. Failures here never reached the token endpoint.
     */
    callback: (
      input: { server: OAuthServer; client: OAuthRegistration; state: string },
      callback: URL,
    ) =>
      Effect.try({
        try: () => {
          // RFC 9207 needs the service's real issuer. A derived one cannot be compared, so an
          // `iss` the service sends (Google does) is ignored rather than rejected.
          const received = new URL(callback);
          if (input.server.issuer_derived === true) received.searchParams.delete("iss");
          const parameters = oauth.validateAuthResponse(
            metadata(input.server),
            input.client,
            received,
            input.state,
          );
          if (!parameters.get("code"))
            throw new OAuthProtocolFailed({ reason: "invalid_response" });
          return parameters;
        },
        catch: failure,
      }).pipe(protocolStage("authorize")),
    exchange: (
      input: {
        server: OAuthServer;
        client: OAuthRegistration;
        redirectUri: string;
        verifier: string;
        resource?: string | undefined;
        nonce?: string | undefined;
        bearerResource?: boolean | undefined;
      },
      parameters: URLSearchParams,
    ) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const sent = await tokenResponse(
          await oauth.authorizationCodeGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            parameters,
            input.redirectUri,
            input.verifier,
            {
              ...settings,
              ...(input.resource === undefined
                ? {}
                : { additionalParameters: { resource: input.resource } }),
            },
          ),
        );
        const response = input.server.issuer_derived === true ? await withoutIdToken(sent) : sent;
        // Executor never uses the ID token, so it is optional even after requesting `openid`.
        // When one is returned, its nonce and claims are still validated.
        const nonce =
          input.nonce !== undefined && (await hasIdToken(response)) ? input.nonce : undefined;
        return oauth.processAuthorizationCodeResponse(server, input.client, response, {
          recognizedTokenTypes: await tokenTypes(response, input.bearerResource),
          ...(nonce === undefined ? {} : { expectedNonce: nonce, requireIdToken: true }),
        });
      }).pipe(protocolStage("exchange")),
    clientCredentials: (input: {
      server: OAuthTokenServer;
      client: OAuthConfidentialRegistration;
      scopes: readonly string[];
      resource?: string | undefined;
      bearerResource?: boolean | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const parameters = new URLSearchParams();
        if (input.scopes.length > 0) parameters.set("scope", input.scopes.join(" "));
        if (input.resource !== undefined) parameters.set("resource", input.resource);
        const response = await tokenResponse(
          await oauth.clientCredentialsGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            parameters,
            settings,
          ),
        );
        return oauth.processClientCredentialsResponse(server, input.client, response, {
          recognizedTokenTypes: await tokenTypes(response, input.bearerResource),
        });
      }).pipe(protocolStage("clientCredentials")),
    refresh: (input: {
      server: OAuthServer;
      client: OAuthRegistration;
      refreshToken: string;
      resource?: string | undefined;
      bearerResource?: boolean | undefined;
      idTokenSubject?: string | undefined;
    }) =>
      request(async (settings) => {
        const server = metadata(input.server);
        const response = await tokenResponse(
          await oauth.refreshTokenGrantRequest(
            server,
            input.client,
            clientAuth(input.client),
            input.refreshToken,
            {
              ...settings,
              ...(input.resource === undefined
                ? {}
                : { additionalParameters: { resource: input.resource } }),
            },
          ),
        );
        const usable =
          input.server.issuer_derived === true ? await withoutIdToken(response) : response;
        const tokens = await oauth.processRefreshTokenResponse(server, input.client, usable, {
          recognizedTokenTypes: await tokenTypes(usable, input.bearerResource),
        });
        // OIDC Core §12.2: a refreshed ID token must identify the same end user.
        const subject = oauth.getValidatedIdTokenClaims(tokens)?.sub;
        if (
          input.idTokenSubject !== undefined &&
          subject !== undefined &&
          subject !== input.idTokenSubject
        )
          throw new OAuthProtocolFailed({
            reason: "subject_changed",
            code: oauth.JWT_CLAIM_COMPARISON,
            field: "id_token",
          });
        return tokens;
      }).pipe(protocolStage("refresh")),
    /** RFC 7009 revocation with the grant's own client authentication. */
    revoke: (input: {
      server: OAuthTokenServer;
      client: OAuthRegistration;
      token: string;
      tokenTypeHint: "refresh_token" | "access_token";
    }) =>
      request(async (settings) =>
        oauth.processRevocationResponse(
          await oauth.revocationRequest(
            metadata(input.server),
            input.client,
            clientAuth(input.client),
            input.token,
            { ...settings, additionalParameters: { token_type_hint: input.tokenTypeHint } },
          ),
        ),
      ).pipe(protocolStage("revoke")),
  };
};

/**
 * Confirm that a protected resource advertises authorization-code OAuth an account connection can
 * complete. Any discovery failure means OAuth is not confirmed; it never selects another method.
 */
export const discoversResourceOAuth = (
  resource: string,
  options: Pick<OAuthOptions, "httpClient" | "urlPolicy">,
) =>
  makeOAuthProtocol({ ...options, clientName: "Executor" })
    .discover({ type: "oauth2", discover: resource, response: {} })
    .pipe(
      Effect.map(
        (found) =>
          found.grant === "authorization_code" &&
          (found.server.code_challenge_methods_supported?.includes("S256") ?? true),
      ),
      Effect.orElseSucceed(() => false),
    );
