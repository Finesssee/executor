import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { AccountsPage as SharedPage } from "@executor-js/ui/dashboard/accounts";
import { Button } from "@executor-js/ui/components/button";
import { Link } from "@tanstack/react-router";
import type { AccountId } from "@executor-js/sdk";
import { useState } from "react";
import {
  LocalAccountActions,
  LocalAccountDialog,
  type AccountDialogKind,
} from "./account-actions.tsx";
/** Local product supplies its own action and typed route. */
export function AccountsPage({ highlight }: { readonly highlight?: AccountId | undefined }) {
  const [dialog, setDialog] = useState<{ account: AccountId; kind: AccountDialogKind }>();
  return (
    <>
      <SharedPage
        query={dashboardAtoms.inventory}
        Failure={Failure}
        highlight={highlight}
        accountActions={(account) => (
          <LocalAccountActions
            account={account}
            open={(kind) => setDialog({ account: account.id, kind })}
          />
        )}
        action={
          <Button asChild>
            <Link to="/accounts/add">Add account</Link>
          </Button>
        }
      />
      {dialog && (
        <LocalAccountDialog
          key={`${dialog.account}:${dialog.kind}`}
          id={dialog.account}
          dialog={dialog.kind}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  );
}
