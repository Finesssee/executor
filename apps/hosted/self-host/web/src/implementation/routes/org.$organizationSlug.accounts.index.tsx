import { AccountConnectionDialog } from "@executor-js/hosted-web/pages/connection-dialog";
import { parseAccountsSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { AccountsPage } from "@executor-js/hosted-web/pages/accounts";

/** Hosted account inventory. */
export const Route = createFileRoute("/org/$organizationSlug/accounts/")({
  validateSearch: parseAccountsSearch,
  component: Page,
});

function Page() {
  const { connection, client, account } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <AccountsPage highlight={account} />
      <AccountConnectionDialog
        connectionId={connection}
        client={client}
        onClose={() => {
          void navigate({ search: { account }, replace: true });
        }}
      />
    </>
  );
}
