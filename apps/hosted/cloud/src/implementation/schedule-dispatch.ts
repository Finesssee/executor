import { Cause, Effect, Exit, Semaphore } from "effect";

/**
 * One coordinator's dispatcher for profile maintenance and due schedules. A profile change is
 * requested, never dropped: a request made while a maintenance pass runs is served by another
 * pass of the same holder, as is saved intent a full pass left behind.
 */
export const makeScheduleDispatch = Effect.gen(function* () {
  const maintenance = yield* Semaphore.make(1);
  let requested = false;
  return {
    /** Record that profile setup has new saved intent. */
    request: Effect.sync(() => {
      requested = true;
    }),
    /** Whether requested profile setup has not yet started a pass. */
    requested: Effect.sync(() => requested),
    run: <PE, PR, SE, SR>(
      /** One profile pass; true when it may have left saved intent behind. */
      profiles: Effect.Effect<boolean, PE, PR>,
      schedules: Effect.Effect<void, SE, SR>,
    ) =>
      Effect.gen(function* () {
        const maintain = Effect.gen(function* () {
          let more: boolean;
          do {
            // Cleared before the pass reads profiles, so a later change requests another.
            requested = false;
            more = yield* profiles;
          } while (more || requested);
        });
        // Maintenance belongs to the coordinator, not each alarm. Due schedules
        // must not queue behind another app's slow profile reconciliation.
        const [profileExit, scheduleExit] = yield* Effect.all(
          [
            maintenance.withPermitsIfAvailable(1)(maintain).pipe(Effect.exit),
            schedules.pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        // Keep both operations scoped and retain either failure without cancelling
        // independently admitted work in the other lane.
        if (Exit.isFailure(profileExit) && Exit.isFailure(scheduleExit))
          return yield* Effect.failCause(Cause.combine(profileExit.cause, scheduleExit.cause));
        if (Exit.isFailure(profileExit)) return yield* Effect.failCause(profileExit.cause);
        if (Exit.isFailure(scheduleExit)) return yield* Effect.failCause(scheduleExit.cause);
      }),
  };
});
