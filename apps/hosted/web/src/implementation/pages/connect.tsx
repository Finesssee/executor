import { usePageUrl } from "@executor-js/dashboard-start/page";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { ScopedConnectionsPage } from "@executor-js/ui/dashboard/scoped-connections";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { resourceInventoryAtom } from "../../contracts/resource-access.ts";
import { connectionToolListAtom } from "../../contracts/apps.ts";
import {
  mcpConnectionsAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { documentationUrl } from "../../contracts/documentation.ts";

/** The member's full-access URL and scoped connections for this organization. */
export function ConnectPage() {
  const page = usePageUrl();
  const { organization } = useOrganizationRoute();
  const docs = new URL(documentationUrl(), page.origin).href;
  return (
    <ScopedConnectionsPage
      key={organization}
      query={resourceInventoryAtom(organization)}
      connections={mcpConnectionsAtom(organization)}
      save={saveMcpConnectionAtom(organization)}
      revoke={revokeMcpConnectionAtom(organization)}
      Failure={HostedFailure}
      docs={docs}
      installation={<McpInstallInstructions endpoint={`${page.origin}/mcp`} docs={docs} />}
      renderTools={({ app, profile, names, onChange }) => (
        <ConnectionToolPicker
          query={connectionToolListAtom({
            organization,
            app: app.id,
            profile: profile?.id,
            expectedProfileRevision: profile?.revision,
            deployment: app.activeDeployment ?? undefined,
          })}
          Failure={HostedFailure}
          names={names}
          onChange={onChange}
        />
      )}
    />
  );
}
