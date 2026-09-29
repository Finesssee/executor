/** A new organization's first Tools index loads the Executor catalog without redundant cache round trips. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { managementApp } from "../support/management-app.ts";

const Index = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** One Tools index request through the actor's own Executor profile. */
const indexTools = (actor: Session, label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      evidence = yield* Evidence;
    const { app, profile } = yield* managementApp(actor);
    const root = `/api/organizations/${actors.organization.id}/apps/${app.id}`;
    const response = yield* api.request(actor, "GET", `${root}/tools/index?profile=${profile.id}`);
    expect(response.status, label).toBe(200);
    const index = yield* body(Index, response);
    const request = (yield* evidence.requests).at(-1);
    if (request === undefined) return yield* Effect.die(new Error("The index request is missing"));
    return { label, request, names: index.items.map((tool) => tool.name).sort() };
  });

/** The app's cache round trips, read from the index request's delivered trace. */
const cacheTrips = (index: Effect.Success<ReturnType<typeof indexTools>>) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    // The app's spans arrive as one batch returned with the invocation's result.
    const spans = yield* telemetry.query(index.request.traceId).pipe(
      Effect.map((result) => result.data.map((row) => row.span)),
      Effect.flatMap((spans) =>
        spans.some((span) => span.operationName === "app.cache.get") &&
        spans.some((span) => span.operationName === "app.dispatch")
          ? Effect.succeed(spans)
          : Effect.fail(new Error(`The ${index.label} trace has not arrived`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 40 }),
    );
    const commands = spans.filter((span) => span.operationName === "app.cache.command");
    const result = spans.find((span) => span.operationName === "app.cache.get")?.tags[
      "cache.result"
    ];
    yield* evidence.json(`${index.label}.json`, {
      durationMs: index.request.durationMs,
      result,
      commands: commands.map((span) => ({
        operation: span.tags["cache.operation"],
        ms: span.durationMs,
      })),
      // Cloud also reports each command from the host side of the RPC when it has arrived.
      host: spans
        .filter((span) => span.operationName === "runtime.cloud.cache")
        .map((span) => ({ operation: span.tags["cache.operation"], ms: span.durationMs })),
    });
    return {
      result,
      count: (operation: string) =>
        commands.filter((span) => span.tags["cache.operation"] === operation).length,
    };
  });

layer(HostedLive, { excludeTestServices: true })("Tools index cache", (it) => {
  it.effect(scenarios.toolsIndexCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const cold = yield* indexTools(actors.owner, "cold-index");
        const warm = yield* indexTools(actors.owner, "warm-index");
        // Another account context runs in its own Worker and reads the shared stored revision.
        const other = yield* indexTools(actors.admin, "other-account-index");
        expect(cold.names.length).toBeGreaterThan(0);
        expect(warm.names).toEqual(cold.names);
        expect(other.names).toEqual(cold.names);
        const [first, second, third] = yield* Effect.all(
          [cacheTrips(cold), cacheTrips(warm), cacheTrips(other)],
          { concurrency: "unbounded" },
        );

        expect(first.result).toBe("miss");
        // One acquire reads and claims the catalog pointer; publishing ends the load's lease.
        expect(first.count("acquire")).toBe(1);
        expect(first.count("write")).toBeGreaterThan(0);
        expect(first.count("publish")).toBe(1);
        expect(first.count("claim")).toBe(0);
        expect(first.count("release")).toBe(0);
        // The loader keeps the revision it stored instead of reading it straight back.
        expect(first.count("read")).toBe(0);

        expect(second.result).toBe("fresh");
        expect(second.count("acquire")).toBe(1);
        expect(second.count("write") + second.count("publish") + second.count("claim")).toBe(0);

        expect(third.result).toBe("fresh");
        expect(third.count("read")).toBeGreaterThan(0);
        expect(third.count("write") + third.count("publish") + third.count("claim")).toBe(0);
      }),
    ),
  );
});
