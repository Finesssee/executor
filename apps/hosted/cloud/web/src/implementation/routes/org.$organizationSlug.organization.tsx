import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";
import { DeleteOrganization } from "../components/delete-organization.tsx";
import { SsoSettings } from "../components/sso-settings.tsx";
import { BillingSettings } from "../components/billing-settings.tsx";

/** Cloud adds billing settings and owner-only removal to the shared organization page. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: () => (
    <OrganizationPage emailInvitations footer={<DeleteOrganization />}>
      <BillingSettings />
      {/* Only enterprise plans show this card, and its plan check calls the billing provider;
          the rest of the page does not wait for it. */}
      <Suspense fallback={null}>
        <SsoSettings />
      </Suspense>
    </OrganizationPage>
  ),
});
