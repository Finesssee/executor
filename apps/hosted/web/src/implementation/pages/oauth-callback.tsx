import { AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Effect, Exit, Option, Redacted, Schema, Cause } from "effect";
import {
  AccountConnectionClosed,
  AccountConnectionTargetChanged,
  OAuthCompletionFailed,
  oauthCompletionRecovery,
  type OAuthCompletionRecovery,
} from "@executor-js/sdk";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { ConnectionStatusPage } from "../components/connection-status.tsx";
import { appError, completeOAuthAtom, PendingOAuth } from "../../contracts/apps.ts";

/** The SDK decides recovery for every completion reason; `setup` means the connection itself ended. */
type Recovery = Exclude<OAuthCompletionRecovery, "cancelled"> | "setup";

type CallbackState =
  | { readonly status: "connecting" }
  | { readonly status: "cancelled"; readonly message: string }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly recovery: Recovery;
      readonly fixPrompt?: string | undefined;
    };

/** Complete provider OAuth in the same browser session that started it. */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const started = useRef(false);
  const [state, setState] = useState<CallbackState>({ status: "connecting" });
  const [pending] = useState(() =>
    Schema.decodeUnknownOption(Schema.fromJsonString(PendingOAuth))(
      sessionStorage.getItem("executor:hosted:oauth"),
    ),
  );
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const callbackSearch = window.location.search;
    window.history.replaceState(null, "", "/oauth/callback");
    if (Option.isNone(pending)) {
      // oxlint-disable-next-line react/set-state-in-effect -- one-time callback handling on mount
      setState({
        status: "failed",
        message:
          "This sign-in has expired or was started in another tab. Open the app and connect again.",
        recovery: "setup",
      });
      return;
    }
    const callback = new URL(pending.value.redirectUri);
    callback.search = callbackSearch;
    const { organization, organizationSlug, connection, app, profile } = pending.value;
    void (async () => {
      const mutation = completeOAuthAtom({ organization, connection });
      registry.set(mutation, { callbackUrl: Redacted.make(callback.href), app });
      const result = await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
      );
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause);
        const completion = Option.filter(error, Schema.is(OAuthCompletionFailed));
        const recovery = Option.match(completion, {
          onSome: (failure) => oauthCompletionRecovery[failure.reason],
          onNone: () =>
            Option.exists(
              error,
              (value) =>
                Schema.is(AccountConnectionClosed)(value) ||
                Schema.is(AccountConnectionTargetChanged)(value),
            )
              ? ("setup" as const)
              : ("restart" as const),
        });
        if (recovery === "cancelled") {
          sessionStorage.removeItem("executor:hosted:oauth");
          setState({
            status: "cancelled",
            message: "No account was connected. You can return to the app and try again.",
          });
          return;
        }
        setState({
          status: "failed",
          message: appError(result.cause),
          recovery,
          fixPrompt: Option.match(error, {
            onSome: (value) =>
              recovery === "configuration" && UserFacingError.is(value) && value.agentFixable
                ? `While connecting an account in Executor.\n\n${value.fixPrompt}`
                : undefined,
            onNone: () => undefined,
          }),
        });
        return;
      }
      sessionStorage.removeItem("executor:hosted:oauth");
      if (app !== null) {
        await navigate({
          to: "/org/$organizationSlug/apps/$appId",
          params: { organizationSlug, appId: app },
          search: { view: "accounts", profile },
        });
      } else
        await navigate({
          to: "/org/$organizationSlug/accounts/$accountId",
          params: { organizationSlug, accountId: result.value.id },
        });
    })();
  }, [registry, navigate, pending]);
  return (
    <ConnectionStatusPage
      status={state.status}
      label={Option.isSome(pending) ? pending.value.label : undefined}
      message={
        state.status !== "connecting"
          ? state.message
          : Option.isSome(pending) && pending.value.app !== null
            ? "Finishing sign-in. You’ll return to the app automatically."
            : "Finishing sign-in. Your account will open automatically."
      }
    >
      {state.status !== "connecting" && (
        <OAuthRecoveryActions
          pending={pending}
          recovery={state.status === "cancelled" ? "cancelled" : state.recovery}
          fixPrompt={state.status === "failed" ? state.fixPrompt : undefined}
        />
      )}
    </ConnectionStatusPage>
  );
}

/** Recovery links resume the original connection or return to its owning app. */
function OAuthRecoveryActions({
  pending,
  recovery,
  fixPrompt,
}: {
  readonly pending: Option.Option<typeof PendingOAuth.Type>;
  readonly recovery: Recovery | "cancelled";
  readonly fixPrompt?: string | undefined;
}) {
  if (Option.isNone(pending))
    return (
      <Button asChild>
        <Link to="/">Open Executor</Link>
      </Button>
    );
  const context = pending.value;
  // Entered clients are saved only after a successful sign-in, so a retry reopens their fields.
  const retry =
    recovery === "restart" ||
    recovery === "client" ||
    (recovery === "cancelled" && context.app === null)
      ? {
          label: recovery === "client" ? "Update client details" : "Try again",
          search:
            recovery === "client" || (recovery !== "cancelled" && context.manualClient)
              ? { client: "change" as const }
              : {},
        }
      : undefined;
  const primary = retry === undefined && fixPrompt === undefined;
  return (
    <>
      {fixPrompt !== undefined && (
        <CopyButton
          code={fixPrompt}
          label="Copy fix prompt"
          text="Copy fix prompt"
          variant="default"
          size="default"
          inline
        />
      )}
      {retry !== undefined && (
        <Button asChild>
          <Link
            to="/org/$organizationSlug/connections/$connectionId"
            params={{
              organizationSlug: context.organizationSlug,
              connectionId: context.connection,
            }}
            search={retry.search}
          >
            {retry.label}
          </Link>
        </Button>
      )}
      {context.app !== null ? (
        <Button variant={primary ? "default" : "outline"} asChild>
          <Link
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug: context.organizationSlug, appId: context.app }}
            search={{ view: "accounts", profile: context.profile }}
          >
            Back to app
          </Link>
        </Button>
      ) : retry === undefined ? (
        <Button asChild variant={primary ? "default" : "outline"}>
          <Link
            to="/org/$organizationSlug/accounts"
            params={{ organizationSlug: context.organizationSlug }}
          >
            Open Accounts
          </Link>
        </Button>
      ) : null}
    </>
  );
}
