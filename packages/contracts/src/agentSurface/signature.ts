/**
 * One-line signatures of a path's input, such as (thread.read :threadId :host? ...), so an agent can
 * call it without asking goat_describe: :key? is optional, [] a list, {} an object, a|b its values,
 * and ... keys the line leaves out.
 */
import type { AgentSurfaceEntry } from "./types.ts";

type Schema = { readonly [key: string]: unknown };

const MAX_ENUM_VALUES = 6;

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const branchesOf = (schema: Schema) =>
  [schema.anyOf, schema.oneOf].flatMap((list) => (Array.isArray(list) ? list : []));

// Optional fields are advertised as anyOf [T, null]; the null branch says nothing to a caller.
const unwrap = (schema: Schema): Schema => {
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches)) return schema;
  const nonNull = branches.filter((branch) => isSchema(branch) && branch.type !== "null");
  const [only] = nonNull;
  return nonNull.length === 1 && isSchema(only) ? unwrap(only) : schema;
};

const choices = (schema: Schema) => {
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : schema.const === undefined
      ? undefined
      : [schema.const];
  return values !== undefined && values.length <= MAX_ENUM_VALUES
    ? `=${values.map(String).join("|")}`
    : "";
};

const hasFields = (schema: Schema) =>
  isSchema(schema.properties) ||
  isSchema(schema.additionalProperties) ||
  branchesOf(schema).some((branch) => isSchema(branch) && isSchema(branch.properties));

const requiredOf = (schema: Schema): ReadonlyArray<unknown> =>
  Array.isArray(schema.required) ? schema.required : [];

/** One key as its anyOf/oneOf alternatives declare it: a hint only when every one allows it. */
const merged = (alternatives: ReadonlyArray<Schema>): Schema => {
  const [first] = alternatives;
  if (first === undefined || alternatives.length === 1) return first ?? {};
  const values = alternatives.map((alternative) =>
    Array.isArray(alternative.enum)
      ? alternative.enum
      : alternative.const === undefined
        ? undefined
        : [alternative.const],
  );
  if (values.every((list) => list !== undefined)) return { enum: [...new Set(values.flat())] };
  if (alternatives.every(hasFields)) return { anyOf: alternatives };
  const types = new Set(alternatives.map((alternative) => alternative.type));
  return types.size === 1 ? { type: first.type } : {};
};

/**
 * An object's keys, with those its anyOf/oneOf alternatives declare: a key is required when the
 * object or every alternative requires it. A schema for additionalProperties means keys no line lists.
 */
const fieldsOf = (schema: Schema) => {
  const own = isSchema(schema.properties) ? schema.properties : {};
  const properties: Record<string, unknown> = { ...own };
  const required = new Set(requiredOf(schema));
  const alternatives = branchesOf(schema).filter(
    (branch): branch is Schema => isSchema(branch) && branch.type !== "null",
  );
  const declaring = alternatives.filter((branch) => isSchema(branch.properties));
  for (const key of new Set(
    declaring.flatMap((branch) => Object.keys(branch.properties as Schema)),
  ))
    if (!Object.hasOwn(own, key))
      properties[key] = merged(
        declaring.flatMap((branch) => {
          const value = (branch.properties as Schema)[key];
          return isSchema(value) ? [unwrap(value)] : [];
        }),
      );
  const [first, ...rest] = alternatives.map(requiredOf);
  for (const key of declaring.length === 0 ? [] : (first ?? []))
    if (rest.every((list) => list.includes(key))) required.add(key);
  return { properties, required, open: isSchema(schema.additionalProperties) };
};

const render = (schema: Schema, depth: number, pick: ReadonlyArray<string> | undefined): string => {
  const { properties, required, open } = fieldsOf(schema);
  const picked = (key: string) =>
    pick === undefined ||
    required.has(key) ||
    pick.some((name) => name === key || name.startsWith(`${key}.`));
  const keys = Object.keys(properties);
  const shown = keys.filter(picked);
  const parts = shown.map((key) => {
    const property = properties[key];
    const value = isSchema(property) ? unwrap(property) : {};
    const name = `:${key}${required.has(key) ? "" : "?"}`;
    if (value.type === "array") return `${name}[]`;
    if (!hasFields(value))
      return value.type === "object" ? `${name}{}` : `${name}${choices(value)}`;
    if (depth === 0) return `${name}{}`;
    // A picked object that names none of its own fields shows only its required ones.
    const nested = pick
      ?.filter((picked) => picked.startsWith(`${key}.`))
      .map((picked) => picked.slice(key.length + 1));
    return `${name}{${render(value, depth - 1, nested)}}`;
  });
  return [...parts, ...(shown.length < keys.length || open ? ["..."] : [])].join(" ");
};

/**
 * The signature of a path's input. depth is how many levels of object fields it spells out (1 by
 * default); pick limits the line to those keys, dotted for a nested one, plus every required key at
 * each level it spells out.
 */
export const toSignature = (
  path: string,
  inputSchema: unknown,
  options: { readonly depth?: number; readonly pick?: ReadonlyArray<string> } = {},
) => {
  const fields = isSchema(inputSchema) ? render(inputSchema, options.depth ?? 1, options.pick) : "";
  return fields === "" ? `(${path})` : `(${path} ${fields})`;
};

const SIGNATURES_LEGEND =
  "Common paths (:key? optional, [] list, {} object, a|b values, ... more keys):";

/** What tools/list shows for an entry: its description, then the signatures it carries. */
export const listedDescription = (entry: Pick<AgentSurfaceEntry, "description" | "signatures">) =>
  entry.signatures === undefined
    ? entry.description
    : [entry.description, SIGNATURES_LEGEND, ...entry.signatures].join("\n");
