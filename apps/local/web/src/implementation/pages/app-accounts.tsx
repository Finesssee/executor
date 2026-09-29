import { useContext, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { Effect, Exit, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { accountSelectionAtom, profileMutations } from "../../contracts/profiles.ts";
import { accountUsageAtom, disconnectAccountAtom } from "../../contracts/accounts.ts";
import type { DashboardError } from "../../contracts/errors.ts";
import { Failure } from "../components/common.tsx";
import { AccountForm } from "./add-account.tsx";
import { Link } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import {
  AppAccounts as SharedAccounts,
  RemoveAccountBinding,
  useUnusedAccountPrompt,
} from "@executor-js/ui/dashboard/app-accounts";
import type {
  Account,
  App,
  AccountRequirement,
  SelectedAccounts,
  Profile,
  ProfileId,
} from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";

/** Save one slot of the shown profile, creating the profile on its first binding. */
export function useAccountChooser({
  app,
  profile,
  onSelected,
}: {
  readonly app: App;
  readonly profile: Profile | undefined;
  readonly onSelected: (id: ProfileId) => void;
}) {
  const registry = useContext(RegistryContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<DashboardError>>();
  const choose = async (slot: string, value: SelectedAccounts[string]) => {
    const base: SelectedAccounts =
      profile?.accounts ??
      Object.fromEntries(
        Object.entries(app.requirements.accounts)
          .filter(([, requirement]) => requirement.cardinality === "many")
          .map(([name]) => [name, []]),
      );
    const mutation = accountSelectionAtom({
      app: app.id,
      target:
        profile === undefined
          ? { kind: "new", request: crypto.randomUUID() }
          : { kind: "saved", id: profile.id, revision: profile.revision },
    });
    setPending(true);
    setError(undefined);
    registry.set(mutation, { app: app.id, accounts: { ...base, [slot]: value } });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true }),
    );
    setPending(false);
    if (Exit.isFailure(exit)) setError(exit.cause);
    else if (exit.value.id !== profile?.id) onSelected(exit.value.id);
    return exit;
  };
  return { choose, pending, error };
}

/** Choose saved accounts in place and connect new ones without leaving the Accounts tab. */
export function AppAccounts({
  app,
  data,
  profile,
  onSelected,
  onCreateProfile,
}: {
  readonly onSelected: (id: ProfileId) => void;
  readonly onCreateProfile?: (() => void) | undefined;
  readonly app: App;
  readonly data: DashboardOverview;
  readonly profile: Profile | undefined;
}) {
  const chooser = useAccountChooser({ app, profile, onSelected });
  const unused = useUnusedAccountPrompt({
    usage: accountUsageAtom,
    remove: disconnectAccountAtom,
    Failure,
  });
  const [connection, setConnection] = useState<{
    readonly slot: string;
    readonly requirement: AccountRequirement;
  }>();
  const [connecting, setConnecting] = useState(false);
  // A saved account shows at once. Drop it once the inventory lists it, so the inventory alone
  // decides later changes: a deleted account must not reappear from this copy.
  const [added, setAdded] = useState<readonly Account[]>([]);
  const pending = added.filter((account) => !data.accounts.some((item) => item.id === account.id));
  if (pending.length !== added.length) setAdded(pending);
  const accounts = [...data.accounts, ...pending];
  return (
    <>
      <SharedAccounts
        app={app}
        selection={profile?.accounts ?? {}}
        accounts={accounts}
        onCreateProfile={onCreateProfile}
        chooser={{
          pending: chooser.pending,
          choose: (slot, value) => void chooser.choose(slot, value),
        }}
        removeAccountAction={(slot, account, label) =>
          profile !== undefined && (
            <RemoveAccountBinding
              profile={profile}
              slot={slot}
              account={account}
              label={label}
              update={profileMutations({ app: app.id, profile: profile.id }).update}
              Failure={Failure}
              onRemoved={(removed) => void unused.check(removed)}
            />
          )
        }
        accountActions={(slot, requirement) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-full justify-start rounded-none px-3.5 text-[13px] text-muted-foreground hover:text-foreground"
            disabled={chooser.pending}
            onClick={() => setConnection({ slot, requirement })}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
            Connect new account
          </Button>
        )}
        reconnectAction={(account) => (
          <Button variant="outline" size="sm" asChild>
            <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
              Reconnect
            </Link>
          </Button>
        )}
      />
      {chooser.error && <Failure cause={chooser.error} />}
      {unused.prompt}
      <Dialog
        open={connection !== undefined}
        onOpenChange={(open) => {
          if (!open && !connecting) setConnection(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
          <DialogTitle>Connect {connection?.requirement.definition.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Connect an account for {app.name}.
          </DialogDescription>
          {connection && (
            <AccountForm
              provider={{
                id: connection.requirement.provider,
                definition: connection.requirement.definition,
              }}
              returnTo={{ app: app.id, slot: connection.slot, profile: profile?.id }}
              checkWith={connection.requirement.health === true ? app.id : undefined}
              onPendingChange={setConnecting}
              onSaved={(account) => {
                const { slot, requirement } = connection;
                const current = profile?.accounts[slot];
                setConnection(undefined);
                setAdded((current) => [...current, account]);
                void chooser.choose(
                  slot,
                  requirement.cardinality === "many"
                    ? [...new Set([...(Array.isArray(current) ? current : []), account.id])]
                    : account.id,
                );
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
