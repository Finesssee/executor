/**
 * Released host protocols are immutable. Retained builds and published `apps` versions speak them,
 * so every later host must keep running and rebuilding those bundles unchanged. This check compares
 * the JSON Schema of each released protocol's messages with its committed snapshot in
 * `packages/apps/protocols/`. A difference means the boundary changed: restore the old schema and
 * define the next protocol with a host adapter instead. See notes/apps-publishing.md.
 *
 * `--write` records snapshots for protocols that have none yet. It never replaces a snapshot; to
 * reshape a protocol that has not been released, delete its unreleased snapshot first.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { frameworkProtocol } from "../packages/apps/src/contracts/protocol-version.ts";
import { releasedProtocols } from "../packages/apps/src/contracts/protocols/released.ts";
import { supportedProtocols } from "../packages/sdk/src/implementation/app-protocols.ts";

const directory = new URL("../packages/apps/protocols/", import.meta.url);
const write = process.argv.includes("--write");

/** Documentation annotations do not change the wire format. */
const documentation = new Set(["description", "title", "examples", "markdownDescription"]);
const structure = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(structure)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !documentation.has(key))
            .map(([key, entry]) => [key, structure(entry)]),
        )
      : value;

const failures: string[] = [];
const released = new Set<number>();
for (const protocol of releasedProtocols) {
  released.add(protocol.version);
  const generated = {
    protocol: protocol.version,
    schemas: Object.fromEntries(
      Object.entries(protocol.schemas).map(([name, schema]) => [
        name,
        structure(Schema.toJsonSchemaDocument(schema)),
      ]),
    ),
  };
  const file = new URL(`${protocol.version}.json`, directory);
  let committed: unknown;
  try {
    committed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    if (write) {
      writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`);
      console.log(`Recorded protocol ${protocol.version}.`);
      continue;
    }
    failures.push(`Protocol ${protocol.version} has no snapshot. Run with --write to record it.`);
    continue;
  }
  if (isDeepStrictEqual(committed, JSON.parse(JSON.stringify(generated)))) continue;
  const changed = Object.keys(generated.schemas).filter(
    (name) =>
      !isDeepStrictEqual(
        (committed as { schemas?: Record<string, unknown> }).schemas?.[name],
        JSON.parse(JSON.stringify(generated.schemas[name])),
      ),
  );
  failures.push(
    `Released protocol ${protocol.version} changed (${changed.join(", ") || "message list"}). ` +
      "Released protocols are immutable: restore the old schema, then add a new protocol and a host adapter.",
  );
}
for (const name of readdirSync(directory)) {
  const version = Number(name.replace(/\.json$/, ""));
  if (!released.has(version))
    failures.push(
      `Snapshot ${name} has no released protocol. Released protocols are never removed.`,
    );
}
if (!released.has(frameworkProtocol))
  failures.push(`The framework speaks protocol ${frameworkProtocol}, which is not released.`);
if (!supportedProtocols.includes(frameworkProtocol))
  failures.push(`Hosts do not support protocol ${frameworkProtocol}, which the framework speaks.`);
for (const version of released)
  if (!supportedProtocols.includes(version))
    failures.push(`Hosts dropped released protocol ${version}; retained builds still speak it.`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`Host protocols unchanged: ${[...released].join(", ")}.`);
