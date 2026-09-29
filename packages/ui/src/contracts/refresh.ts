/** Focus-driven refresh for dashboard reads that also render on the server. */
import { Atom } from "effect/unstable/reactivity";

/**
 * Counts returns to a visible page. A server render has no window, so its value never changes
 * there and each read starts once for that request.
 */
const pageFocus = Atom.readable((get) => {
  if (typeof window === "undefined") return 0;
  let count = 0;
  const update = () => {
    if (document.visibilityState === "visible") get.setSelf(++count);
  };
  window.addEventListener("visibilitychange", update);
  get.addFinalizer(() => window.removeEventListener("visibilitychange", update));
  return count;
});

/** Refresh an atom when the page becomes visible again. */
export const refreshOnFocus = Atom.makeRefreshOnSignal(pageFocus);
