import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { Exit } from "effect";
import { useState } from "react";
import { acceptInvitationAtom } from "../../contracts/organization.ts";
import { organizationError, OrganizationDestination } from "../components/organization.tsx";
import { Button } from "@executor-js/ui/components/button";
import { LoginFrame } from "./login-frame.tsx";

/** Invitation IDs are untrusted; Better Auth verifies recipient email and expiry. */
export const inviteSearch = (search: Record<string, unknown>) => ({
  invitation: typeof search.invitation === "string" ? search.invitation : "",
});
/** Accept after authentication, including users who have no organization yet. */
export function InvitePage({ invitation }: { readonly invitation: string }) {
  const accept = useAtomSet(acceptInvitationAtom, { mode: "promiseExit" });
  const state = useAtomValue(acceptInvitationAtom);
  const [joined, setJoined] = useState<OrganizationId>();
  const [error, setError] = useState<string | null>(null);
  if (joined) return <OrganizationDestination organization={joined} />;
  return (
    <LoginFrame title="Join an organization">
      <div className="flex flex-col gap-6 text-center">
        <p className="text-sm leading-6 text-balance text-muted-foreground">
          {invitation
            ? "You've been invited to an organization on Executor. Accept with the email this invitation was sent to."
            : "This invitation link is incomplete. Ask for a new link."}
        </p>
        <Button
          className="min-h-10 w-full"
          disabled={!invitation || state.waiting}
          onClick={async () => {
            setError(null);
            const result = await accept(invitation);
            if (Exit.isFailure(result)) setError(organizationError(result.cause));
            else setJoined(result.value);
          }}
        >
          {state.waiting ? "Joining…" : "Accept invitation"}
        </Button>
        {error && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error}
          </p>
        )}
      </div>
    </LoginFrame>
  );
}
