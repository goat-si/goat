import { resolveAgentSurfaceEntry } from "./resolve.ts";

/**
 * The argument shapes agents send goat_describe and goat_call first, mapped onto path and args:
 * MCP's own tools/call shape ({name, arguments}), tool, input, and resource with verb. Agents that
 * guessed these spent a turn on the refusal before (D8, docs/operations/agent-surface-eval.md).
 * The server accepts them and every reader of a goat_call's target reads it through here, so an
 * approval or a label cannot judge an aliased call differently from the call that ran.
 */
const PATH_KEYS = ["path", "name", "tool"] as const;
const ARGS_KEYS = ["args", "arguments", "input"] as const;

export type SurfaceArguments =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly conflict: readonly [string, string] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with sorted keys, so two objects that differ only in key order compare equal. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "undefined");

// A path and a tool name for the same entry agree.
const pathTarget = (value: unknown) =>
  typeof value === "string" ? (resolveAgentSurfaceEntry(value)?.path ?? value) : canonical(value);

/** The one value several keys carry, or the first two keys whose values differ. */
const pick = (
  values: ReadonlyArray<readonly [key: string, value: unknown]>,
  sameAs: (value: unknown) => string,
): {
  readonly found: boolean;
  readonly value?: unknown;
  readonly conflict?: readonly [string, string];
} => {
  const [first, ...rest] = values;
  if (first === undefined) return { found: false };
  const other = rest.find(([, value]) => sameAs(value) !== sameAs(first[1]));
  return other === undefined
    ? { found: true, value: first[1] }
    : { found: false, conflict: [first[0], other[0]] };
};

/**
 * A goat_describe or goat_call payload with its aliases folded into path and args. Keys it does
 * not know, a lone verb among them, are left for the undeclared-argument refusal.
 */
export const surfaceArguments = (tool: string, payload: unknown): SurfaceArguments => {
  if ((tool !== "goat_call" && tool !== "goat_describe") || !isRecord(payload))
    return { ok: true, payload };
  const { resource, verb, ...rest } = payload;
  // resource with a verb is a path; for goat_describe a resource alone is one too. A verb that is
  // not a string stays behind, so the undeclared-argument refusal names it.
  const parts =
    typeof resource === "string" &&
    (typeof verb === "string" || (tool === "goat_describe" && verb === undefined))
      ? [["resource", typeof verb === "string" ? `${resource}.${verb}` : resource] as const]
      : [];
  const argsKeys: ReadonlyArray<string> = tool === "goat_call" ? ARGS_KEYS : [];
  const present = (keys: ReadonlyArray<string>) =>
    keys.filter((key) => Object.hasOwn(rest, key)).map((key) => [key, rest[key]] as const);
  const path = pick([...present(PATH_KEYS), ...parts], pathTarget);
  if (path.conflict !== undefined) return { ok: false, conflict: path.conflict };
  const args = pick(present(argsKeys), canonical);
  if (args.conflict !== undefined) return { ok: false, conflict: args.conflict };
  const folded = new Set<string>([...PATH_KEYS, ...argsKeys]);
  return {
    ok: true,
    payload: {
      ...Object.fromEntries(Object.entries(rest).filter(([key]) => !folded.has(key))),
      ...(parts.length === 0 && resource !== undefined ? { resource } : {}),
      ...(parts.length === 0 && verb !== undefined ? { verb } : {}),
      ...(path.found ? { path: path.value } : {}),
      ...(args.found ? { args: args.value } : {}),
    },
  };
};

/** The path and args a goat_call input names, however it spelled them; none when they conflict. */
export const goatCallTarget = (
  input: unknown,
): { readonly path?: unknown; readonly args?: unknown } => {
  const folded = surfaceArguments("goat_call", input);
  return folded.ok && isRecord(folded.payload)
    ? { path: folded.payload.path, args: folded.payload.args }
    : {};
};
