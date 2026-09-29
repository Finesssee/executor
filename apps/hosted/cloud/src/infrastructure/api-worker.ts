/** Bind the API Worker without importing its routes and application initialization. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { ArtifactsTokenCoordinator } from "./artifacts-tokens.ts";

/** Stable native Worker identity; main.ts supplies its implementation and properties. */
export class Api extends Cloudflare.Worker<Api, {}, ArtifactsTokenCoordinator>()("Api") {}
