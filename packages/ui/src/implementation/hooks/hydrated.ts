/** Distinguish hydration from later renders of the same component. */
import { useSyncExternalStore } from "react";

const unchanging = () => () => {};

/**
 * `false` while this component renders on the server or hydrates, `true` afterwards. Use it only
 * for browser-only inputs the server cannot see, such as a URL fragment.
 */
export const useHydrated = () =>
  useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  );
