/** Retained Worker code and optional private browser asset metadata. */
import { UiAsset } from "./runtime.ts";
import { Effect, Schema } from "effect";

export { WorkerBundle } from "@executor-js/app-data/worker-bundle";
import { WorkerBundle } from "@executor-js/app-data/worker-bundle";
export type WorkerBundle = typeof WorkerBundle.Type;

/** A host protocol number. Whether this host runs it is decided by its protocol adapters. */
export const AppProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * An executable `apps` framework: the host protocol it speaks and its ready-to-link server and
 * browser modules. Published packages carry it as `runtime.json`; hosts carry their own snapshot.
 */
export const PublishedAppFramework = Schema.Struct({
  protocol: AppProtocolVersion,
  version: Schema.NonEmptyString,
  server: Schema.Record(Schema.String, Schema.String),
  browser: Schema.Record(Schema.String, Schema.String),
});
export type AppFramework = typeof PublishedAppFramework.Type;

/** The existing bundle key remains the publication point; builds without a UI omit its metadata. */
export const RetainedWorkerBuild = Schema.Struct({
  ...WorkerBundle.fields,
  database: Schema.Boolean,
  ui: Schema.optional(Schema.Array(UiAsset)),
  /** Every build retained before protocols were recorded speaks protocol 1, the only one then. */
  protocol: AppProtocolVersion.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
});

/**
 * The code a runner loads when it cold-starts a build's Worker, with the host protocol its
 * framework speaks. The runner learns a build's protocol from this load, so warm calls read none.
 */
export const LoadedWorkerBuild = Schema.Struct({
  ...WorkerBundle.fields,
  protocol: AppProtocolVersion,
});
export type LoadedWorkerBuild = typeof LoadedWorkerBuild.Type;
