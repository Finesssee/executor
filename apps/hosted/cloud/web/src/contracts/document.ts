/** Request data the Worker hands to the document renderer. */
import type { HostedDocument } from "@executor-js/hosted-web/document";
import type { CloudEntryPage } from "../../../src/contracts/entry.ts";

/** The Worker reads the beta notice dismissal from the request's cookies. */
export { betaNoticeDismissed } from "@executor-js/ui/contracts/early-preview";

export interface CloudDocumentContext extends HostedDocument {
  /** Sign-in or team setup data the Worker resolved for this page, if it is an entry page. */
  readonly entry: CloudEntryPage | null;
  /** Whether this browser dismissed the beta notice. */
  readonly betaNoticeDismissed: boolean;
}
