import { createFileRoute } from "@tanstack/react-router";
import { AccountCredentialsPage } from "../pages/account-credentials.tsx";
import { parseAccountParams } from "../route-params.ts";
/** Generated-tree route for /_dashboard/_inventory/accounts/$accountId_/credentials. */
export const Route = createFileRoute("/_dashboard/_inventory/accounts/$accountId_/credentials")({
  staticData: { section: "accounts" },
  params: { parse: parseAccountParams },
  component: AccountRoute,
});

function AccountRoute() {
  const { accountId } = Route.useParams();
  return <AccountCredentialsPage key={accountId} id={accountId} />;
}
