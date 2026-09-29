/** Start's document handler. The local server calls it in-process for dashboard pages. */
import { createStartHandler } from "@tanstack/react-start/server";
import { completeDocumentHandler } from "@executor-js/dashboard-start/complete-document";

// Local reads finish within milliseconds, so each page is sent complete; see the handler.
export default { fetch: createStartHandler(completeDocumentHandler) };
