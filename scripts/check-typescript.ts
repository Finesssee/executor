/**
 * Fails unless `tsc` is the @effect/tsgo build. The `prepare` script patches it on install;
 * an unpatched compiler would skip the Effect diagnostics without failing.
 */
import { execFileSync } from "node:child_process";

const version = execFileSync("tsc", ["--version"], { encoding: "utf8" }).trim();
if (!version.includes("+effect-tsgo.")) {
  console.error(`${version} is not patched with @effect/tsgo. Run \`bun install\` to patch it.`);
  process.exit(1);
}
console.log(version);
