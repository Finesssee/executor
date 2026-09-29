/** Page address during rendering, identical on the server and in the browser that hydrates it. */
import { useRouter } from "@tanstack/react-router";

/**
 * The current URL, including the query exactly as received. Signed OAuth parameters must not be
 * re-serialized, so this reads the history location rather than the router's parsed search.
 */
export function usePageUrl(): URL {
  const router = useRouter();
  const { pathname, search, hash } = router.history.location;
  return new URL(pathname + search + hash, router.origin);
}
