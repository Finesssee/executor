/**
 * Creates or updates `.reference/effect-v4/` at the Effect commit pinned in the
 * root package.json. See notes/coding-style.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, ".reference", "effect-v4");
const remote = "https://github.com/Effect-TS/effect.git";
const pin = /^https:\/\/pkg\.pr\.new\/Effect-TS\/effect\/(?:@effect\/)?[\w-]+@([0-9a-f]{40})$/;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const commits = new Map<string, string[]>();
for (const field of ["dependencies", "devDependencies", "overrides"]) {
  for (const [name, spec] of Object.entries<string>(manifest[field] ?? {})) {
    if (name !== "effect" && !name.startsWith("@effect/")) continue;
    const commit =
      pin.exec(spec)?.[1] ??
      fail(`${field}.${name} is not a commit-pinned pkg.pr.new URL: ${spec}`);
    commits.set(commit, [...(commits.get(commit) ?? []), `${field}.${name}`]);
  }
}
if (commits.size !== 1) {
  fail(
    commits.size === 0
      ? "No effect or @effect/* pins found in package.json."
      : `Effect pins disagree:\n${[...commits].map(([commit, names]) => `  ${commit}: ${names.join(", ")}`).join("\n")}`,
  );
}
const [commit] = commits.keys();

if (!existsSync(join(dir, ".git"))) {
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} exists but is not a git checkout.`);
  mkdirSync(dir, { recursive: true });
  git("init", "--quiet");
} else {
  const changes = git("status", "--porcelain");
  if (changes) fail(`${dir} has local changes; leaving it untouched:\n${changes}`);
  // An interrupted first run can leave a repository without a HEAD commit.
  const head = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  if (head === commit) {
    console.log(`.reference/effect-v4 is already at ${commit}.`);
    process.exit(0);
  }
}

git("fetch", "--quiet", "--depth", "1", remote, commit);
git("checkout", "--quiet", "--detach", "FETCH_HEAD");
console.log(`.reference/effect-v4 is at ${git("rev-parse", "HEAD")}.`);
