/** Browser navigation only. No OAuth code, client secret, or token is persisted here. */
import { Effect, Option, Redacted, Schema } from "effect";
import { OAuthCallbackPath } from "@executor-js/local-server/contracts";
import { OAuthReturn, type OAuthAppReturn } from "../contracts/oauth.ts";
import type { AccountId, AccountConnectionId } from "@executor-js/sdk";

const returnKey = "executor.oauth.return";
/**
 * The callback as the service's redirect delivered it. A fragment never reaches a server, and
 * some services append one (Facebook adds `#_=_`), so the browser drops it here, as the hosted
 * callback does. Completion still rejects any callback URL that carries a fragment.
 */
export const oauthCallbackUrl = (location: URL) => {
  const url = new URL(location);
  url.hash = "";
  return Redacted.make(url.href);
};
/** Remove callback parameters before rendering or making further requests. */
export const readOAuthCallback = Effect.sync(() => {
  const url = new URL(window.location.href);
  if (url.pathname !== OAuthCallbackPath || !url.searchParams.has("state")) return undefined;
  window.history.replaceState(null, "", OAuthCallbackPath);
  return oauthCallbackUrl(url);
});
/** Remember only the account-selection page to resume after provider consent. */
export const openOAuth = (
  authorizationUrl: string,
  connection: AccountConnectionId,
  account?: AccountId,
  returnTo?: Omit<typeof OAuthAppReturn.Type, "connection">,
) =>
  Effect.sync(() => {
    const current = new URL(window.location.href);
    const target = Schema.decodeUnknownOption(OAuthReturn)(
      account === undefined
        ? {
            connection,
            app: current.searchParams.get("app"),
            slot: current.searchParams.get("slot"),
            profile: current.searchParams.get("profile") ?? undefined,
            ...returnTo,
          }
        : { connection, account },
    );
    if (Option.isSome(target))
      window.sessionStorage.setItem(returnKey, JSON.stringify(target.value));
    else window.sessionStorage.removeItem(returnKey);
    window.location.assign(authorizationUrl);
  });
/**
 * Return to setup with a saved account candidate; setup still validates provider compatibility.
 * A reconnect returns to its account and keeps its name.
 */
export const oauthDestination = (account: AccountId) =>
  Effect.sync(() => {
    const saved = window.sessionStorage.getItem(returnKey);
    window.sessionStorage.removeItem(returnKey);
    const target =
      saved === null
        ? Option.none()
        : Schema.decodeUnknownOption(Schema.fromJsonString(OAuthReturn))(saved);
    const reconnect = Option.isSome(target) && "account" in target.value;
    const destination =
      Option.isSome(target) && "app" in target.value
        ? ({
            to: "/apps/$appId/setup",
            params: { appId: target.value.app },
            search: {
              selected: account,
              slot: target.value.slot,
              ...(target.value.profile === undefined ? {} : { profile: target.value.profile }),
            },
          } as const)
        : ({ to: "/accounts", search: { account } } as const);
    return { destination, reconnect };
  });
