import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

/**
 * Whether a remote's tools/list offers any memory tool. A remote that predates the listing flip
 * lists memory tools under their shipped names and a newer one under goat_memory_*, so both count.
 */
export const advertisesMemoryTools = (tools: ReadonlyArray<{ readonly name: string }>) =>
  tools.some((tool) => resolveAgentSurfaceEntry(tool.name)?.resource === "memory");
