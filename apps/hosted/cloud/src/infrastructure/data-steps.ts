/**
 * Cloud runs data steps inside the new Worker after it deploys. Schema migrations run earlier, in
 * Alchemy, with only a database connection; data steps need the Worker's services, such as app
 * source in Cloudflare Artifacts. The minute cron advances them from the SQL journal the schema
 * migration created, never from a request. An older Worker version does not know a new step, so
 * the first tick of the version that ships it starts it. A pass that leaves items to retry records
 * a backoff in the journal, so a step that keeps failing is not retried every minute.
 */
import { AppManagementHost } from "@executor-js/app-management";
import { hostDataSteps, runDataSteps } from "@executor-js/app-management/data-steps";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { Clock, Config, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** A tick stops starting items after this long, then resumes from its cursor on the next tick. */
const tickBudgetMs = 20_000;

/**
 * Read during Worker initialization, so Alchemy binds the deploy's values into the Worker.
 * `CLOUD_DATA_STEPS` is `report` unless a deploy sets `apply`. Every deploy resumes the same
 * report, `report:<CLOUD_DATA_STEPS_REPORT>` (`report:cloud` by default): step names are immutable,
 * so a later build's outcomes for a step are comparable with an earlier one's. A report restarts
 * from the first item only when a deploy sets a new label.
 */
export const cloudDataSteps = Effect.gen(function* () {
  const mode = yield* Config.Literals(["report", "apply"], "CLOUD_DATA_STEPS").pipe(
    Config.withDefault("report" as const),
  );
  const report = yield* Config.NonEmptyString("CLOUD_DATA_STEPS_REPORT").pipe(
    Config.withDefault("cloud"),
  );
  return Effect.gen(function* () {
    const host = yield* Effect.flatten(AppManagementHost);
    const sql = yield* Effect.flatten(GroupDatabase);
    const deadline = (yield* Clock.currentTimeMillis) + tickBudgetMs;
    yield* runDataSteps(hostDataSteps(host), {
      journal: "private_hosted",
      mode,
      report,
      exclusive: false,
      deadline,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  }).pipe(Effect.withSpan("job.data-steps", { attributes: { "data_step.mode": mode } }));
}).pipe(Effect.orDie);
