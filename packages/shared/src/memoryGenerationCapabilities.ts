export type MemoryGenerationCapabilities = Readonly<{ summary: boolean; conflict: boolean }>;

export const NO_MEMORY_GENERATION: MemoryGenerationCapabilities = {
  summary: false,
  conflict: false,
};
const MEMORY_GENERATION: MemoryGenerationCapabilities = { summary: true, conflict: true };

/** Configuration-level support, shared with clients reading older provider snapshots. */
export function declareMemoryGeneration(
  driver: string,
  config: { readonly modelRoute?: unknown; readonly serverUrl?: unknown } = {},
): MemoryGenerationCapabilities {
  switch (driver) {
    case "codex":
    case "claudeAgent":
    case "cursor":
    case "grok":
    case "antigravity":
      return MEMORY_GENERATION;
    case "opencode":
      return (config.modelRoute === undefined || config.modelRoute === "default") &&
        (config.serverUrl === undefined ||
          (typeof config.serverUrl === "string" && config.serverUrl.trim() === ""))
        ? MEMORY_GENERATION
        : NO_MEMORY_GENERATION;
    default:
      return NO_MEMORY_GENERATION;
  }
}
