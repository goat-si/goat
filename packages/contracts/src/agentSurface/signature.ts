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

const render = (schema: Schema, depth: number, pick: ReadonlyArray<string> | undefined): string => {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
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
    if (value.type !== "object") return `${name}${choices(value)}`;
    // A picked object without picked fields of its own is named, not spelled out.
    const nested = pick
      ?.filter((picked) => picked.startsWith(`${key}.`))
      .map((picked) => picked.slice(key.length + 1));
    if (depth === 0 || !isSchema(value.properties) || nested?.length === 0) return `${name}{}`;
    return `${name}{${render(value, depth - 1, nested)}}`;
  });
  return [...parts, ...(shown.length < keys.length ? ["..."] : [])].join(" ");
};

/**
 * The signature of a path's input. depth is how many levels of object fields it spells out (1 by
 * default); pick limits the line to those keys, dotted for a nested one, plus every required key,
 * and spells out only the objects it names fields of.
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
  "Common paths, callable without goat_describe (:key? optional, [] list, {} object, a|b values, ... more keys):";

/** What tools/list shows for an entry: its description, then the signatures it carries. */
export const listedDescription = (entry: Pick<AgentSurfaceEntry, "description" | "signatures">) =>
  entry.signatures === undefined
    ? entry.description
    : [entry.description, SIGNATURES_LEGEND, ...entry.signatures].join("\n");
