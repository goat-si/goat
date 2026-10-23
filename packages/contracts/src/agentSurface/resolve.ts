import type { AgentSurfaceEntry } from "./types.ts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "./registry.ts";

/** The name a tool takes once canonical names are listed: goat_<resource>_<verb>. */
export const canonicalToolName = (entry: Pick<AgentSurfaceEntry, "resource" | "verb">) =>
  `goat_${entry.resource}_${entry.verb}`;

const byName = new Map<string, AgentSurfaceRegistryEntry>();
for (const value of Object.values(
  agentSurfaceRegistry,
) as ReadonlyArray<AgentSurfaceRegistryEntry>) {
  byName.set(value.path, value);
  byName.set(canonicalToolName(value), value);
  for (const legacy of value.legacyNames) byName.set(legacy, value);
}

/** Resolves a path, canonical name, or legacy tool name to its registry entry. */
export const resolveAgentSurfaceEntry = (
  pathOrName: string,
): AgentSurfaceRegistryEntry | undefined => byName.get(pathOrName);
