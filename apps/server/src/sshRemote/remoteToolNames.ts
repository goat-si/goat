import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";

/**
 * The last version some of whose builds answer only to shipped tool names: canonical names became
 * callable (#906) and then listed (#781) within it. Every later version answers to both.
 */
const SHIPPED_NAMES_ONLY_THROUGH = "0.1.2";

/** Whether a remote at this serverVersion answers to canonical tool names. */
const answersToCanonicalNames = (serverVersion: string | undefined) =>
  serverVersion !== undefined &&
  parseSemver(serverVersion) !== null &&
  compareSemverVersions(serverVersion, SHIPPED_NAMES_ONLY_THROUGH) > 0;

/**
 * The name to send a tool call under to a remote GOAT: the listed canonical name when the remote
 * answers to it, else the name the tool shipped under, which every version since accepts. A
 * version this machine cannot read counts as old. Names outside the registry pass unchanged.
 */
export const remoteToolName = (tool: string, serverVersion: string | undefined): string => {
  const entry = resolveAgentSurfaceEntry(tool);
  if (entry === undefined) return tool;
  return answersToCanonicalNames(serverVersion) ? listedToolName(entry) : entry.name;
};

/**
 * Whether a remote's tools/list offers any memory tool. A remote that predates the listing flip
 * lists memory tools under their shipped names and a newer one under goat_memory_*, so both count.
 */
export const advertisesMemoryTools = (tools: ReadonlyArray<{ readonly name: string }>) =>
  tools.some((tool) => resolveAgentSurfaceEntry(tool.name)?.resource === "memory");

/** Refusals a destination's goat_thread_launch returns before it creates anything. */
const REFUSED_BEFORE_CREATE = new Set([
  "invalid_request",
  "capability_denied",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "target_required",
]);

/**
 * What a tool's refusal tells the caller. A goat_thread_launch error may come after the thread
 * was created (its projection reads and bookkeeping run after the create commits), so only a
 * refusal it raises before creating anything says the launch never started.
 */
export const toolRefusal = (tool: string, result: { readonly code?: string | undefined }) => ({
  ...(result.code === undefined ? {} : { remoteCode: result.code }),
  ...(tool === "goat_thread_launch" &&
  (result.code === undefined || !REFUSED_BEFORE_CREATE.has(result.code))
    ? { launchMayHaveStarted: true }
    : {}),
});
