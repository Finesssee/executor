/**
 * Group generated OpenAPI tool names as `<group>.<leaf>`, ported from Executor v1's tool paths.
 * The group is the first tag, or the first meaningful path segment. The leaf is the operationId
 * without a repeated group prefix, or a method-and-path name when there is no operationId.
 */

export interface OperationNameInput {
  readonly operationId: string | undefined;
  /** The first non-empty tag. */
  readonly tag: string | undefined;
  readonly method: string;
  readonly path: string;
}

const words = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
const camel = (value: string) => {
  const [first, ...rest] = words(value);
  return first === undefined
    ? ""
    : `${first}${rest.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("")}`;
};
const pascal = (value: string) => {
  const name = camel(value);
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
};

const version = /^v\d+(?:[._-]\d+)?$/i;
const segments = (path: string) =>
  path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
/** Path segments that name resources: not versions, not `api`, not `{parameters}`. */
const resourceSegments = (path: string) =>
  segments(path).filter(
    (segment) =>
      !version.test(segment) &&
      segment.toLowerCase() !== "api" &&
      !(segment.startsWith("{") && segment.endsWith("}")) &&
      camel(segment) !== "",
  );

const groupOf = (input: OperationNameInput) =>
  camel(input.tag ?? "") ||
  camel(resourceSegments(input.path)[0] ?? "") ||
  // Keep "root" for an operation on `/` or a path of only versions and parameters.
  "root";

/**
 * `method` plus the resource segments other than the group: `GET /users/{id}/keys` is
 * `users.getKeys`. When the group is the only segment it is kept (`identity.getIdentity`);
 * only a path without resource segments uses `Operation`.
 */
const fallbackLeaf = (input: OperationNameInput, group: string) => {
  const resources = resourceSegments(input.path).map(camel);
  const others = resources.filter((segment) => segment !== group);
  const suffix = (others.length ? others : resources).map(pascal).join("");
  return camel(`${input.method.toLowerCase()}${suffix || "Operation"}`);
};

const leafOf = (input: OperationNameInput, group: string) => {
  if (input.operationId === undefined) return fallbackLeaf(input, group);
  const [first, ...rest] = input.operationId.split(/[._/]+/).filter((part) => part.length > 0);
  // `accounts_completeOAuth`, `accounts.completeOAuth` and `accounts/completeOAuth` under the
  // `accounts` group all become `completeOAuth`.
  const seed =
    first !== undefined && rest.length > 0 && camel(first).toLowerCase() === group.toLowerCase()
      ? rest.join(" ")
      : input.operationId;
  const leaf = camel(seed);
  return leaf === "" || leaf === group ? fallbackLeaf(input, group) : leaf;
};

/** Deterministic, document-independent short hash for the last collision round. */
const hash = (input: OperationNameInput) => {
  const text = JSON.stringify([input.method.toUpperCase(), input.path, input.operationId ?? null]);
  let value = 0;
  for (let i = 0; i < text.length; i++) value = ((value << 5) - value + text.charCodeAt(i)) | 0;
  return Math.abs(value).toString(36).padStart(8, "0").slice(0, 8);
};

/**
 * Plan one name per input, in input order. Names that collide are refined together: first by
 * the path's version segment, then by the HTTP method, then by a stable hash. Refinement only
 * touches the colliding names, so adding an operation never renames an unrelated one.
 */
export const planOperationNames = (inputs: readonly OperationNameInput[]): string[] => {
  const staged = inputs.map((input) => {
    const group = groupOf(input);
    const leaf = leafOf(input, group);
    const versionSegment = segments(input.path)
      .map((segment) => segment.toLowerCase())
      .find((segment) => version.test(segment));
    const prefix = versionSegment === undefined ? group : `${group}.${camel(versionSegment)}`;
    return { input, group, leaf, prefix, versionSegment, name: `${group}.${leaf}` };
  });
  const refine = (rename: (item: (typeof staged)[number]) => string) => {
    const buckets = new Map<string, typeof staged>();
    for (const item of staged) buckets.set(item.name, [...(buckets.get(item.name) ?? []), item]);
    for (const bucket of buckets.values())
      if (bucket.length > 1) for (const item of bucket) item.name = rename(item);
  };
  refine((item) => (item.versionSegment === undefined ? item.name : `${item.prefix}.${item.leaf}`));
  refine((item) => `${item.prefix}.${item.leaf}${pascal(item.input.method)}`);
  refine((item) => `${item.prefix}.${item.leaf}${pascal(item.input.method)}${hash(item.input)}`);
  return staged.map((item) => item.name);
};
