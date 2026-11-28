import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "./registry.ts";
import { canonicalToolName, listedToolName } from "./surfaceEntries.ts";
import type { AgentSurfaceEntry } from "./types.ts";

export { canonicalToolName, listedToolName };

/**
 * Paths renamed when their verb was normalized (D11), mapped to the path that replaced them.
 * goat_call and goat_describe still accept them and report the replacement as deprecated.
 */
export const legacyAgentSurfacePaths: ReadonlyMap<string, string> = new Map([
  ["decision.get", "decision.read"],
  ["permission_profile.get", "permission_profile.read"],
  ["thread.configuration", "thread.configuration_read"],
  ["provider.sync_status", "provider.sync_read"],
  ["origin.reports_wait", "origin.report_wait"],
  ["memory.read_source", "memory.source_read"],
  ["memory.settings_get", "memory.settings_read"],
  ["preview.wait_for", "preview.wait"],
]);

const byName = new Map<string, AgentSurfaceRegistryEntry>();
const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
for (const value of entries) {
  byName.set(value.path, value);
  byName.set(canonicalToolName(value), value);
  byName.set(value.name, value);
  for (const legacy of value.legacyNames) byName.set(legacy, value);
}
for (const [legacy, path] of legacyAgentSurfacePaths) {
  const entry = byName.get(path);
  if (entry !== undefined) byName.set(legacy, entry);
}

/** Resolves a path, canonical name, legacy tool name, or renamed path to its registry entry. */
export const resolveAgentSurfaceEntry = (
  pathOrName: string,
): AgentSurfaceRegistryEntry | undefined => byName.get(pathOrName);

/** Whether ToolAdmission reserves this write's clientRequestId (docs/internals/agent-surface.md#idempotency). */
export const isKeyedWrite = (entry: AgentSurfaceEntry) => entry.idempotency === "key";

/** Whether a repeat with the same clientRequestId can be deduplicated, by ToolAdmission or the write's own store. */
export const deduplicatesClientRequestId = (entry: AgentSurfaceEntry) =>
  entry.idempotency === "key" || entry.idempotency === "domain";

// null and false read as omitted: optional ids decode null to absent, and stopCascade defaults false.
const isSet = (value: unknown) => value !== undefined && value !== null && value !== false;

/** Whether this call's clientRequestId deduplicates it, so a transient failure is safe to repeat. */
export const isDeduplicatedCall = (
  entry: AgentSurfaceEntry,
  args: Readonly<Record<string, unknown>>,
) =>
  typeof args.clientRequestId === "string" &&
  deduplicatesClientRequestId(entry) &&
  !(entry.keyIgnoredWith ?? []).some((name) => isSet(args[name]));

/**
 * Shipped tool names mapped to the name /mcp lists the tool under. A tools/call by one of them
 * still runs (docs/internals/agent-surface.md#names) and reports the listed name as deprecated.
 */
export const legacyToolNameTargets: ReadonlyMap<string, string> = new Map(
  entries.flatMap((entry) =>
    entry.legacyNames.map((legacy) => [legacy, listedToolName(entry)] as const),
  ),
);

/**
 * The replacement a caller should use instead of a deprecated name or path, in the same form:
 * the listed name for a legacy tool name, the current path for a renamed path.
 */
export const deprecatedReplacement = (pathOrName: string): string | undefined =>
  legacyToolNameTargets.get(pathOrName) ?? legacyAgentSurfacePaths.get(pathOrName);
