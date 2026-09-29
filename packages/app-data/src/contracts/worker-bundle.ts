/** Portable Worker modules. Binary bytes are base64 only at the retained JSON boundary. */
import { Schema } from "effect";

/** A compiled dependency can supply JavaScript or a statically imported WASM module. */
export const WorkerBundle = Schema.Struct({
  mainModule: Schema.NonEmptyString,
  modules: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Struct({ js: Schema.String }),
      Schema.Struct({ wasm: Schema.Uint8ArrayFromBase64 }),
    ]),
  ),
});

/** Convert decoded bytes to the exact ArrayBuffer contract required by Worker Loader. */
export const workerModules = (modules: (typeof WorkerBundle.Type)["modules"]) =>
  Object.fromEntries(
    Object.entries(modules).map(([name, module]) => [
      name,
      typeof module === "object" && "wasm" in module
        ? { wasm: module.wasm.slice().buffer }
        : module,
    ]),
  );

/**
 * The method every runtime-owned Worker entrypoint exports so its host can unload it. The pinned
 * workerd keeps each named Worker Loader entry for the life of the process; only `abortIsolate`,
 * run inside the loaded Worker, removes the entry and lets the isolate go. It stops the isolate's
 * execution, so its caller sees an internal error rather than a result. A runtime without it
 * returns false and keeps the Worker.
 */
export const retireMethod = `retire() {
    if (typeof workers.abortIsolate !== "function") return false;
    workers.abortIsolate("Unloaded by the app Worker budget");
  }`;
