import type { DisplayFormat } from "@executor-js/ui/contracts/display";

/** What every server-rendered document receives from its host, beside product-specific context. */
export interface DocumentApi {
  /** Reads this host's API in-process with the document request's identity. */
  readonly apiFetch: typeof globalThis.fetch;
  /** The requested path and query exactly as received, for return links such as sign-in. */
  readonly path: string;
  /** The request's locale and saved time zone for dates and numbers. */
  readonly display: DisplayFormat;
}
