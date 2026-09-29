/** One build owns the shared marketing, docs and dashboard output. */
import * as Command from "alchemy/Command";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { postHogBindings } from "./posthog.ts";
import { sentryBindings } from "./sentry.ts";
import { cloudOrigin } from "./stage.ts";

/** Alchemy reuses this resource when the API and development server request it. */
export const cloudSite = Effect.gen(function* () {
  const analytics = yield* postHogBindings;
  const sentry = yield* sentryBindings;
  // Pages label their browser telemetry with the environment the Worker's telemetry uses: the
  // stage when deployed, and the development process's own setting otherwise.
  const environment = (yield* AlchemyContext).dev ? {} : { EXECUTOR_ENVIRONMENT: yield* Stage };
  return yield* Command.Build("Site", {
    cwd: "../../..",
    command: "bun run hosted:cloud:site:build",
    outdir: "apps/hosted/cloud/.generated/site",
    env: {
      ...analytics.build,
      ...sentry.build,
      ...environment,
      EXECUTOR_SITE_ORIGIN: yield* cloudOrigin.pipe(Effect.orDie),
    },
  });
});
