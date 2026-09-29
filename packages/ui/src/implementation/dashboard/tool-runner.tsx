import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AppProviderFailed, Json, type Tool } from "@executor-js/sdk";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useId, useState, type ComponentType } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Textarea } from "../components/textarea.tsx";
import { Code } from "./code.tsx";
import { ProviderErrorNotice } from "./provider-error-notice.tsx";

type JsonSchema = { readonly [key: string]: unknown };
const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A starting value for each required input; optional fields stay out of the draft. */
const skeleton = (schema: unknown, depth = 0): unknown => {
  if (!isSchema(schema) || depth > 4) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0 && !isSchema(schema.properties))
    return skeleton(variants[0], depth + 1);
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : (schema.type ?? (isSchema(schema.properties) ? "object" : undefined));
  switch (type) {
    case "object": {
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.fromEntries(
        required
          .filter((name): name is string => typeof name === "string")
          .map((name) => [name, skeleton(properties[name], depth + 1)]),
      );
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
};
const initialInput = (tool: Tool | undefined) => {
  const value = tool === undefined ? {} : skeleton(tool.inputSchema);
  return JSON.stringify(isSchema(value) ? value : {}, null, 2);
};

/**
 * Run one tool with a JSON draft. The product binds the call to its exact app, profile revision
 * and deployment, and renders its own failures; provider failures keep the shared account recovery.
 */
export function ToolRunner<E>({
  tool,
  call,
  detail,
  Failure,
}: {
  readonly tool: string;
  readonly call: Atom.AtomResultFn<Json, Json, E>;
  /** The selected tool's schemas seed the draft with its required inputs. */
  readonly detail: Query<Tool | undefined, unknown>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const run = useAtomSet(call, { mode: "promiseExit" });
  const schema = useAtomValue(detail);
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<"json" | Cause.Cause<E>>();
  const inputId = useId();
  const input = draft ?? initialInput(AsyncResult.isSuccess(schema) ? schema.value : undefined);
  const failure =
    error === undefined || error === "json" ? Option.none() : Cause.findErrorOption(error);
  return (
    <div
      data-product-private
      className="flex flex-col gap-4 mt-6 min-w-0 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_pre]:text-[11px] [&_pre]:bg-muted [&_pre]:p-[12px] [&_pre]:rounded-[6px]"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          const parsed = Schema.decodeUnknownExit(Schema.fromJsonString(Json))(input);
          if (Exit.isFailure(parsed)) {
            setError("json");
            return;
          }
          setPending(true);
          setOutput(undefined);
          const result = await run(parsed.value);
          setPending(false);
          if (Exit.isFailure(result)) setError(result.cause);
          else setOutput(JSON.stringify(result.value, null, 2));
        }}
      >
        <div className="flex flex-col gap-2.25 text-[13px] font-medium">
          <label htmlFor={inputId}>Input</label>
          <Textarea
            id={inputId}
            className="font-mono text-xs min-h-40"
            value={input}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            disabled={pending}
          />
        </div>
        <Button className="mt-3" disabled={pending}>
          {pending ? "Running…" : "Run tool"}
        </Button>
      </form>
      {error === "json" ? (
        <p role="alert" className="text-destructive text-[13px]">
          Enter valid JSON.
        </p>
      ) : Option.isSome(failure) && Schema.is(AppProviderFailed)(failure.value) ? (
        <ProviderErrorNotice
          error={failure.value}
          context={`While running tool ${tool}. Check whether it made changes before trying again.`}
        />
      ) : (
        error !== undefined && <Failure cause={error} />
      )}
      {output !== undefined && (
        <section aria-label="Tool result">
          <Code code={output} copyable copyLabel="Copy result" />
        </section>
      )}
    </div>
  );
}
