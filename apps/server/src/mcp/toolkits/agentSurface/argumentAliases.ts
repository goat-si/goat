import { OrchestratorMcpFailure } from "@goat/contracts";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

/**
 * The argument shapes agents send goat_describe and goat_call first, mapped onto path and args:
 * MCP's own tools/call shape ({name, arguments}), tool, input, and resource with verb. Agents that
 * guessed these spent a whole turn on the refusal before (D8, docs/operations/agent-surface-eval.md).
 * The listed schemas keep only path and args, so the aliases cost no listing bytes.
 */
const PATH_ALIASES = ["path", "name", "tool"] as const;
const ARGS_ALIASES = ["args", "arguments", "input"] as const;

type Aliased =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly failure: OrchestratorMcpFailure };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One value for a field several keys may carry, or the two keys whose values differ by sameAs. */
const pick = (
  values: ReadonlyArray<readonly [key: string, value: unknown]>,
  sameAs: (value: unknown) => unknown,
): { readonly value?: unknown; readonly conflict?: readonly [string, string] } => {
  const [first, ...rest] = values;
  if (first === undefined) return {};
  const target = JSON.stringify(sameAs(first[1]));
  const other = rest.find(([, value]) => JSON.stringify(sameAs(value)) !== target);
  return other === undefined ? { value: first[1] } : { conflict: [first[0], other[0]] };
};

// A path and a tool name for the same entry agree.
const pathTarget = (value: unknown) =>
  typeof value === "string" ? (resolveAgentSurfaceEntry(value)?.path ?? value) : value;

const conflict = (tool: string, [a, b]: readonly [string, string]): Aliased => ({
  ok: false,
  failure: new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `${tool} got both ${a} and ${b}, which name different things, so nothing ran. Pass one.`,
  }),
});

export const surfaceArgumentAliases = (tool: string, payload: unknown): Aliased => {
  if ((tool !== "goat_call" && tool !== "goat_describe") || !isRecord(payload))
    return { ok: true, payload };
  const { resource, verb, ...rest } = payload;
  // resource with a verb is a path; resource alone is one, for goat_describe.
  const fromParts =
    typeof resource === "string" && (typeof verb === "string" || tool === "goat_describe")
      ? [["resource", typeof verb === "string" ? `${resource}.${verb}` : resource] as const]
      : [];
  const named = (keys: ReadonlyArray<string>) =>
    keys.filter((key) => Object.hasOwn(rest, key)).map((key) => [key, rest[key]] as const);
  const path = pick([...named(PATH_ALIASES), ...fromParts], pathTarget);
  if (path.conflict !== undefined) return conflict(tool, path.conflict);
  const args = tool === "goat_call" ? pick(named(ARGS_ALIASES), (value) => value) : {};
  if (args.conflict !== undefined) return conflict(tool, args.conflict);
  // Leftovers, a lone verb among them, still meet the undeclared-argument refusal.
  const leftover = Object.fromEntries(
    Object.entries(rest).filter(
      ([key]) =>
        !(PATH_ALIASES as ReadonlyArray<string>).includes(key) &&
        !(tool === "goat_call" && (ARGS_ALIASES as ReadonlyArray<string>).includes(key)),
    ),
  );
  return {
    ok: true,
    payload: {
      ...leftover,
      ...(fromParts.length === 0 && resource !== undefined ? { resource } : {}),
      ...(fromParts.length === 0 && verb !== undefined ? { verb } : {}),
      ...("value" in path ? { path: path.value } : {}),
      ...("value" in args ? { args: args.value } : {}),
    },
  };
};
