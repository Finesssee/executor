/** App database budgets and reserved fields fail with named errors through hosted deploy, tool calls and workflow steps. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, mutation, query, router, workflow, number, object, string, table } from "apps";
const database = defineDatabase({
  items: table({ group: string(), n: number() }).index("by_group", ["group"]),
});
const lookup = async (db, times) => {
  const rows = [];
  for (let n = 0; n < times; n++)
    rows.push(await db.items.withIndex("by_group", (q) => q.eq("group", "g")).first());
  return rows;
};
const scan = mutation({ input: object({}) }, async ({ db }) => (await lookup(db, 101)).length);
export default defineApp({ accounts: {}, database }, {
  tools: router({
    count: query({ input: object({}) }, async ({ db }) => db.items.withIndex("by_creation").count()),
    lookups: query({ input: object({ times: number() }) }, async ({ db }, { times }) =>
      (await lookup(db, times)).filter((row) => row !== null).length),
    takes: query({ input: object({ first: number(), second: number() }) }, async ({ db }, { first, second }) => [
      (await db.items.withIndex("by_group", (q) => q.eq("group", "g")).take(first)).length,
      (await db.items.withIndex("by_creation").take(second)).length,
    ]),
    seed: mutation({ input: object({ count: number() }) }, async ({ db }, { count }) => {
      for (let n = 0; n < count; n++) await db.items.insert({ group: "g", n });
      return count;
    }),
    swallowed: mutation({ input: object({}) }, async ({ db }) => {
      await db.items.insert({ group: "g", n: -1 });
      try { await lookup(db, 101); } catch { return "caught"; }
      return "unreachable";
    }),
    scan,
  }),
  workflows: {
    // A retry waits a minute, longer than the scenario waits for the run to fail.
    scanRun: workflow({ input: object({}) }, async (ctx) =>
      ctx.step.runMutation("scan", scan, {}, { retries: { limit: 1, delay: "1 minute" } })),
  },
});`,
  },
  appsManifest,
];

const reserved = [
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, query, object, router, string, table } from "apps";
const database = defineDatabase({ events: table({ title: string(), createdAt: string() }) });
export default defineApp({ accounts: {}, database }, {
  tools: router({ list: query({ input: object({}) }, async ({ db }) => db.events.withIndex("by_creation").collect()) }),
});`,
  },
  appsManifest,
];

const CallFailed = Schema.Struct({ _tag: Schema.Literal("ToolCallFailed"), reason: Schema.String });
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(
    Schema.Struct({
      step: Schema.optionalKey(Schema.String),
      errorName: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("DeploymentBuildFailed"),
  reason: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("App data limits", (it) => {
  it.effect(scenarios.appDataLimits.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;

        const rejected = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Reserved field ${randomUUID().slice(0, 8)}`,
          files: reserved,
        });
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
        expect((yield* body(BuildFailed, rejected)).reason).toContain(
          'Table "events" declares "createdAt", which is reserved',
        );

        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Data limits ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const kinds = {
          count: "query",
          lookups: "query",
          takes: "query",
          seed: "mutation",
          swallowed: "mutation",
        } as const;
        const call = (tool: keyof typeof kinds, input: Record<string, number> = {}) =>
          api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
            tool,
            kind: kinds[tool],
            input,
          });
        const failure = (tool: keyof typeof kinds, input: Record<string, number> = {}) =>
          Effect.gen(function* () {
            const response = yield* call(tool, input);
            expect(response.status, JSON.stringify(response.body)).toBe(502);
            return (yield* body(CallFailed, response)).reason;
          });

        expect(yield* body(Schema.Number, yield* call("seed", { count: 7 }))).toBe(7);

        // 100 index queries fit; the 101st names the budget instead of a generic failure.
        expect(yield* body(Schema.Number, yield* call("lookups", { times: 100 }))).toBe(100);
        const lookups = yield* failure("lookups", { times: 101 });
        expect(lookups).toContain("101 index queries; the limit is 100");
        expect(lookups).toContain("instead of one first() per item");

        // Returned rows are charged as returned: a small first result reserves nothing.
        expect(
          yield* body(
            Schema.Array(Schema.Number),
            yield* call("takes", { first: 200, second: 1000 }),
          ),
        ).toEqual([7, 7]);
        expect(yield* failure("takes", { first: 1, second: 1001 })).toContain(
          "One call asked for 1,001 rows; take(n) and paginate({ numItems }) accept at most 1,000",
        );

        // Catching the rejection neither hides the limit nor commits the mutation's insert.
        expect(yield* failure("swallowed")).toContain("101 index queries; the limit is 100");
        expect(yield* body(Schema.Number, yield* call("count"))).toBe(7);

        // A workflow step that exceeds a budget fails the run with the named error at once. The
        // same step would exceed it again, so the engine does not wait a minute to retry it.
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${app.id}/workflow-runs`,
          {
            workflow: "scanRun",
            input: {},
            key: randomUUID(),
          },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = (yield* body(Run, started)).id;
        const deadline = (yield* Clock.currentTimeMillis) + 40_000;
        let current = yield* body(Run, started);
        while (current.status !== "errored") {
          expect(["complete", "terminated"], JSON.stringify(current)).not.toContain(current.status);
          expect(yield* Clock.currentTimeMillis, JSON.stringify(current)).toBeLessThan(deadline);
          yield* Effect.sleep("100 millis");
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/${app.id}/workflow-runs/${run}`,
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          current = yield* body(Run, response);
        }
        expect(current.error).toBe("execution");
        expect(current.failure).toMatchObject({ step: "scan", errorName: "DatabaseLimitExceeded" });
        expect(current.failure?.message).toContain("101 index queries; the limit is 100");
      }),
    ),
  );
});
