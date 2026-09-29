import { AccountAccessSettings } from "./resource-settings.tsx";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import type { AccountDetail, AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { accountNeedsSignIn } from "@executor-js/ui/contracts/dashboard";
import { useAtomSet } from "@effect/atom-react";
import type { AccountId } from "@executor-js/sdk";
import { useNavigate } from "@tanstack/react-router";
import { Exit, type Cause } from "effect";
import { useState, type ReactNode } from "react";
import {
  AccountActionsMenu,
  AccountDialog,
  AccountDialogIdentity,
  DisconnectAccountForm,
  RenameAccountForm,
} from "@executor-js/ui/dashboard/account-actions";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { AccountHealthPanel } from "@executor-js/ui/dashboard/account-health";
import { Button } from "@executor-js/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@executor-js/ui/components/dropdown-menu";
import type { AccountAccess } from "@executor-js/hosted-server/resource-access";
import {
  accountAtom,
  checkAccountAtom,
  disconnectAccountAtom,
  reconnectAccountAtom,
  renameAccountAtom,
} from "../../contracts/accounts.ts";
import type { HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** The list page owns an open dialog, so it outlives the row if the account changes underneath it. */
export type AccountDialogKind = "rename" | "health" | "access" | "delete";

/** Row actions replace the account page: credentials, name, access and deletion, in place. */
export function HostedAccountActions({
  account,
  access,
  oauth,
  open,
}: {
  readonly account: AccountSummary;
  readonly access: typeof AccountAccess.Type | undefined;
  readonly oauth: boolean;
  readonly open: (dialog: AccountDialogKind) => void;
}) {
  const reconnect = useReconnect(account.id);
  const reconnectLabel = oauth ? "Reconnect" : "Update credentials";
  const credentialsReason =
    access === undefined || access.canManage
      ? undefined
      : "Only the account creator and organization admins can update its credentials.";
  return (
    <>
      {reconnect.error && <HostedFailure cause={reconnect.error} />}
      {accountNeedsSignIn(account) && (
        <Button
          variant="outline"
          size="sm"
          loading={reconnect.pending}
          disabledReason={credentialsReason}
          onClick={reconnect.start}
        >
          {reconnectLabel}
        </Button>
      )}
      <AccountActionsMenu account={account}>
        <DropdownMenuItem onSelect={() => open("rename")}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open("health")}>Check health</DropdownMenuItem>
        <DropdownMenuItem
          disabled={credentialsReason !== undefined || reconnect.pending}
          onSelect={reconnect.start}
        >
          {reconnectLabel}
        </DropdownMenuItem>
        {access?.ownership.kind === "shared" && (
          <DropdownMenuItem onSelect={() => open("access")}>Manage access</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => open("delete")}>
          Delete account
        </DropdownMenuItem>
      </AccountActionsMenu>
    </>
  );
}

/** Start a reconnect and open its connection dialog over the account list. */
function useReconnect(account: AccountId) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const reconnect = useAtomSet(reconnectAccountAtom, { mode: "promiseExit" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  return {
    pending,
    error,
    start: async () => {
      setPending(true);
      setError(undefined);
      const result = await reconnect({ organization, account });
      setPending(false);
      if (Exit.isFailure(result)) {
        setError(result.cause);
        return;
      }
      await navigate({
        to: "/org/$organizationSlug/accounts",
        params: { organizationSlug },
        search: { connection: result.value.id, account },
      });
    },
  };
}

const titles = {
  rename: "Rename account",
  health: "Account health",
  access: "Manage access",
  delete: "Delete account?",
} satisfies Record<AccountDialogKind, string>;

/** Rename, access and deletion load the account themselves and report it if it disappears. */
export function HostedAccountDialog({
  id,
  dialog,
  onClose,
}: {
  readonly id: AccountId;
  readonly dialog: AccountDialogKind;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const [busy, setBusy] = useState(false);
  return (
    <AccountDialog
      title={titles[dialog]}
      description={`${titles[dialog]} for this saved account.`}
      busy={busy}
      onClose={onClose}
    >
      <QueryView
        pending={<DetailSkeleton label="Loading account" />}
        query={accountAtom({ organization, account: id })}
        Failure={HostedFailure}
      >
        {(data) =>
          dialog === "rename" ? (
            <RenameDialogBody data={data} onPendingChange={setBusy} onClose={onClose} />
          ) : dialog === "health" ? (
            <HealthDialogBody data={data} onClose={onClose} />
          ) : dialog === "access" ? (
            <>
              <AccountDialogIdentity data={data} />
              <AccountAccessSettings account={id} />
            </>
          ) : (
            <DeleteDialogBody data={data} onPendingChange={setBusy} onClose={onClose} />
          )
        }
      </QueryView>
    </AccountDialog>
  );
}

const cancelButton = (onClose: () => void): ReactNode => (
  <Button variant="ghost" onClick={onClose}>
    Cancel
  </Button>
);

function HealthDialogBody({
  data,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const check = useAtomSet(checkAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <AccountHealthPanel<HostedError>
      data={data}
      check={() => check()}
      Failure={HostedFailure}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    />
  );
}

function RenameDialogBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const rename = useAtomSet(renameAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <RenameAccountForm<HostedError>
      account={data.account}
      rename={rename}
      Failure={HostedFailure}
      disabledReason={
        data.canManage
          ? undefined
          : "Only the account creator and organization admins can manage this shared account."
      }
      onPendingChange={onPendingChange}
      onDone={onClose}
      cancel={cancelButton(onClose)}
    />
  );
}

function DeleteDialogBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: AccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const disconnect = useAtomSet(disconnectAccountAtom({ organization, account: data.account.id }), {
    mode: "promiseExit",
  });
  return (
    <DisconnectAccountForm<HostedError>
      submitLabel="Delete account"
      impact={
        <p className="text-[12px] leading-[1.5] text-muted-foreground">
          These apps lose this account. Their other selected accounts stay connected.
        </p>
      }
      data={data}
      Failure={HostedFailure}
      disabledReason={
        data.canManage
          ? undefined
          : "Only the account creator and organization admins can delete this shared account."
      }
      disconnect={() => disconnect()}
      onPendingChange={onPendingChange}
      onDisconnected={onClose}
      cancel={cancelButton(onClose)}
    />
  );
}
