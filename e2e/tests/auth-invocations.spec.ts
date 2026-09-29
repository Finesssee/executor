/**
 * Cloud keeps one Better Auth instance for each Worker isolate. Concurrent requests from
 * different users must still read their own sessions, and each request's auth SQL must run
 * as that request's work: its timing spans belong to the request's own trace.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Telemetry } from "../support/evidence.ts";

const SessionBody = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  session: Schema.Struct({ userId: Schema.String }),
});

/** Read the caller's session under a new trace, so its spans can be found afterwards. */
const readSession = (actor: Session) =>
  Effect.gen(function* () {
    const traceId = randomBytes(16).toString("hex");
    const response = yield* actor.send("GET", "/api/auth/get-session", undefined, {
      traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
    });
    expect(response.status).toBe(200);
    return { traceId, session: yield* body(SessionBody, response) };
  });

layer(HostedLive, { excludeTestServices: true })("Auth invocations", (it) => {
  it.effect(scenarios.authInvocations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const telemetry = yield* Telemetry;
        const people = [actors.owner, actors.admin, actors.member];
        const users = yield* Effect.forEach(people, (actor) =>
          readSession(actor).pipe(Effect.map(({ session }) => session.user.id)),
        );
        expect(new Set(users).size).toBe(people.length);

        // Interleave every user's requests so they share the Worker at the same time.
        const reads = yield* Effect.forEach(
          Array.from({ length: 4 }, () => people.map((actor, index) => ({ actor, index }))).flat(),
          ({ actor, index }) =>
            readSession(actor).pipe(Effect.map((read) => ({ ...read, user: users[index] }))),
          { concurrency: "unbounded" },
        );
        for (const read of reads) {
          expect(read.session.user.id).toBe(read.user);
          expect(read.session.session.userId).toBe(read.user);
        }

        // Each read issued its own session query. Its timing span must arrive in the
        // read's trace, attached to a span of that same trace.
        for (const { traceId } of reads) {
          const spans = yield* telemetry.query(traceId).pipe(
            Effect.map((found) => found.data),
            Effect.filterOrFail(
              (found) => found.some(({ span }) => span.operationName === "auth.sql.timing"),
              () => new Error(`No auth SQL timing span arrived in trace ${traceId}`),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
          const ids = new Set(spans.map(({ span }) => span.spanId));
          for (const { span } of spans.filter(
            ({ span }) => span.operationName === "auth.sql.timing",
          ))
            expect(span.parentSpanId !== null && ids.has(span.parentSpanId)).toBe(true);
        }
      }),
    ),
  );
});
