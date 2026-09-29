import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Clock, Effect, Fiber } from "effect";
import { cacheApp } from "../support/cache-app.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheStalledLoader.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { request, call } = yield* cacheApp;
        // The first caller claims the key, stores one part and then stops making progress.
        const holder = yield* request("stalled").pipe(Effect.forkScoped);
        yield* call("stalledStarted").pipe(
          Effect.repeat({ until: (value) => value === true }),
          Effect.timeout("10 seconds"),
        );
        // Concurrent callers never wait out the stalled holder's lease: each gets a value
        // well inside an MCP execute's 30-second budget.
        const started = yield* Clock.currentTimeMillis;
        const readers = yield* Effect.all(
          [call("stalledReader"), call("stalledReader"), call("stalledReader")],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("25 seconds"));
        const waited = (yield* Clock.currentTimeMillis) - started;
        for (const value of readers) expect(value).toEqual(expect.any(String));
        expect(waited).toBeLessThan(25_000);
        // When the holder ends without publishing, its lease is released and the next caller
        // publishes a value every later caller reuses.
        yield* call("stalledRelease");
        expect((yield* Fiber.join(holder).pipe(Effect.timeout("15 seconds"))).status).toBe(502);
        const published = yield* call("stalledReader").pipe(Effect.timeout("10 seconds"));
        expect(readers).not.toContain(published);
        expect(yield* call("stalledReader").pipe(Effect.timeout("5 seconds"))).toBe(published);
      }),
    ),
  );
});
