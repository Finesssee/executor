import type { HostedApiDocument } from "../contracts/api.ts";
/** Supply shared catalog reads and source preparation to hosted handlers. */
import { createCatalog } from "@executor-js/catalog";
import type { SourceFile } from "@executor-js/sdk/core";
import { Effect, Layer } from "effect";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { HostedCatalog } from "../contracts/catalog.ts";
import { Authentication } from "../contracts/auth.ts";
import { executorCatalogEntry } from "./executor-catalog-entry.ts";

/**
 * Fetch the public integrations.sh feed on request. Layer construction performs no network I/O.
 * The API document, authoring skills and Executor app source are only needed to prepare the
 * Executor app, so they load on that request instead of during server startup.
 */
export const catalogLive = (
  skills: Effect.Effect<readonly SourceFile[]>,
  document: Effect.Effect<HostedApiDocument>,
  egress: HostEgress,
) =>
  Layer.effect(
    HostedCatalog,
    Effect.gen(function* () {
      const { origin } = yield* Authentication;
      const published = createCatalog(egress);
      const executor = executorCatalogEntry(origin);
      return HostedCatalog.of({
        list: published.list.pipe(
          Effect.map((entries) => [
            executor,
            ...entries.filter((entry) => entry.id !== executor.id),
          ]),
        ),
        custom: published.custom,
        prepare: (input) =>
          input.entry === executor.id
            ? Effect.all([
                Effect.promise(() => import("./executor-app.ts")),
                skills,
                document,
              ]).pipe(
                Effect.flatMap(([{ executorAppSource }, skills, document]) =>
                  executorAppSource(origin, skills, document),
                ),
                Effect.map(({ files }) => ({ files })),
                Effect.withSpan("catalog.generate", {
                  attributes: {
                    "catalog.stage": "generate",
                    "catalog.entry.id": executor.id,
                    "catalog.entry.kind": executor.kind,
                  },
                }),
              )
            : published.prepare(input),
      });
    }),
  );
