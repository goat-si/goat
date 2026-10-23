import type { AgentSurfaceEntry } from "./types.ts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "./registry.ts";

/** The name a tool takes once canonical names are listed: goat_<resource>_<verb>. */
export const canonicalToolName = (entry: Pick<AgentSurfaceEntry, "resource" | "verb">) =>
  `goat_${entry.resource}_${entry.verb}`;

const byName = new Map<string, AgentSurfaceRegistryEntry>();
const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
for (const value of entries) {
  byName.set(value.path, value);
  byName.set(canonicalToolName(value), value);
  for (const legacy of value.legacyNames) byName.set(legacy, value);
}

/** Resolves a path, canonical name, or legacy tool name to its registry entry. */
export const resolveAgentSurfaceEntry = (
  pathOrName: string,
): AgentSurfaceRegistryEntry | undefined => byName.get(pathOrName);

/**
 * Canonical names a served tool also answers to, mapped to the name it is served under. /mcp
 * accepts them in tools/call and leaves them out of tools/list until the listing flip
 * (docs/internals/agent-surface.md#rollout, step 10). The meta tools keep their short names.
 */
export const canonicalToolAliases: ReadonlyMap<string, string> = new Map(
  entries
    .filter((entry) => entry.resource !== "surface" && canonicalToolName(entry) !== entry.name)
    .map((entry) => [canonicalToolName(entry), entry.name] as const),
);
