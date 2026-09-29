import type { HostedDocument } from "@executor-js/hosted-web/document";
import { getGlobalStartContext } from "@tanstack/react-start";

/** Server only: the context the product server passed with this document request. */
export const serverDocument = (): HostedDocument => {
  const document = getGlobalStartContext();
  if (document === undefined)
    throw new Error("The document context is only available on the server");
  return document;
};

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: HostedDocument };
  }
}
