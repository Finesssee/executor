import { defineConfig } from "vitest/config";

/** In-process checks of the PGlite build the self-host product bundles. */
export default defineConfig({
  test: { include: ["e2e/tests/pglite-results.spec.ts"], testTimeout: 60_000 },
});
