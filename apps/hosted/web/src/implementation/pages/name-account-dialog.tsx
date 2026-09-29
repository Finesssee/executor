import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Exit } from "effect";
import type { Account, AccountId } from "@executor-js/sdk";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import {
  NameAccountForm,
  NameAccountHeader,
  NameAccountModal,
  suggestedAccountName,
} from "@executor-js/ui/dashboard/name-account";
import {
  accountAtom,
  accountToNameAtom,
  checkAccountAtom,
  renameAccountAtom,
} from "../../contracts/accounts.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";

// The organization layout mounts this on every page, so it imports only what the prompt needs.

/** Prompt for a name for the organization's newly connected account, over whatever page follows. */
export function NameAccountDialog() {
  const { organization } = useOrganizationRoute();
  const pending = useAtomValue(accountToNameAtom);
  const setPending = useAtomSet(accountToNameAtom);
  const [busy, setBusy] = useState(false);
  if (pending === undefined || pending.organization !== organization) return null;
  const close = () => setPending(undefined);
  return (
    <NameAccountModal
      key={pending.account}
      handoff={pending.saved !== undefined}
      busy={busy}
      onClose={close}
    >
      {pending.saved ? (
        <>
          <NameAccountHeader provider={pending.saved.provider} />
          <HostedNameAccount
            account={{ id: pending.account, label: pending.saved.account.label }}
            providerName={pending.saved.provider.definition.name}
            onPendingChange={setBusy}
            onDone={close}
          />
        </>
      ) : (
        <LoadedNameAccount accountId={pending.account} onPendingChange={setBusy} onDone={close} />
      )}
    </NameAccountModal>
  );
}

/** After an OAuth return the prompt has only the account ID, so it reads the account first. */
function LoadedNameAccount({
  accountId,
  onPendingChange,
  onDone,
}: {
  readonly accountId: AccountId;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const query = useQuery(accountAtom({ organization, account: accountId }));
  return (
    <QueryResult
      result={query.result}
      retry={query.refresh}
      Failure={HostedFailure}
      pending={
        <>
          <NameAccountHeader />
          <DetailSkeleton label="Loading account" />
        </>
      }
    >
      {({ account, provider }) => (
        <>
          <NameAccountHeader provider={provider} />
          <HostedNameAccount
            account={account}
            providerName={provider.definition.name}
            onPendingChange={onPendingChange}
            onDone={onDone}
          />
        </>
      )}
    </QueryResult>
  );
}

/** Name a just-connected account through the organization's account API. */
function HostedNameAccount({
  account,
  providerName,
  onPendingChange,
  onDone,
}: {
  readonly account: Pick<Account, "id" | "label">;
  readonly providerName: string;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const rename = useAtomSet(renameAccountAtom({ organization, account: account.id }), {
    mode: "promiseExit",
  });
  const check = useAtomSet(checkAccountAtom({ organization, account: account.id }), {
    mode: "promiseExit",
  });
  // A targeted connection is selected before this prompt opens, so one check can name it.
  const [identity, setIdentity] = useState<
    { readonly resolving: true } | { readonly resolving: false; readonly name: string | undefined }
  >({ resolving: true });
  useEffect(() => {
    let active = true;
    void check().then((exit) => {
      if (active)
        setIdentity({
          resolving: false,
          name: Exit.isSuccess(exit) ? suggestedAccountName(exit.value) : undefined,
        });
    });
    return () => {
      active = false;
    };
  }, [check]);
  return (
    <NameAccountForm
      account={account}
      providerName={providerName}
      rename={rename}
      Failure={HostedFailure}
      identity={identity}
      {...(onPendingChange ? { onPendingChange } : {})}
      onDone={onDone}
    />
  );
}
