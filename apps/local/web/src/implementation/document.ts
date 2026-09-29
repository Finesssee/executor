import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import { getGlobalStartContext } from "@tanstack/react-start";

/** Server only: the context the local server passed with this document request. */
export const serverDocument = (): DocumentApi => {
  const document = getGlobalStartContext();
  if (document === undefined)
    throw new Error("The document context is only available on the server");
  return document;
};

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: DocumentApi };
  }
}
