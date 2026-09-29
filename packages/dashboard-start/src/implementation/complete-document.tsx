/**
 * Render the whole document before sending it, for hosts whose reads finish in milliseconds.
 *
 * Streaming reveals each Suspense boundary through React's inline script, which holds a reveal
 * until 300 ms after the previous one. That suits a host whose reads take longer: its frame paints
 * first and content follows. A host that reads from its own process finishes every read long
 * before then, so it sends one complete document instead, and the page paints once with its data.
 * Settled atom values still go ahead of the markup that uses them.
 */
import { StartServer } from "@tanstack/react-start/server";
import {
  createSsrStreamResponse,
  defineHandlerCallback,
  getSsrStatus,
  transformReadableStreamWithRouter,
} from "@tanstack/react-router/ssr/server";
import { renderToReadableStream } from "react-dom/server";

export const completeDocumentHandler = defineHandlerCallback(
  async ({ request, router, responseHeaders }) => {
    const rendered = await renderToReadableStream(<StartServer router={router} />, {
      signal: request.signal,
      nonce: router.options.ssr?.nonce,
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError: (error) => {
        if (!request.signal.aborted) console.error("Dashboard render failed", error);
      },
    });
    await rendered.allReady;
    return createSsrStreamResponse(
      router,
      new Response(
        transformReadableStreamWithRouter(router, rendered, {
          rendererSafePoint: "script-close",
          signal: request.signal,
        }),
        { status: getSsrStatus(router), headers: responseHeaders },
      ),
    );
  },
);
