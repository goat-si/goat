import { agentSurfaceRegistry, type AgentSurfacePath } from "@goat/contracts/agentSurface";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

/** The names /mcp lists, which is what provider configs must name to allow or disable a tool. */
const listed = (path: AgentSurfacePath) => listedToolName(agentSurfaceRegistry[path]);

const GOAT_MEMORY_READ_TOOL_NAMES: ReadonlyArray<string> = (
  ["memory.list", "memory.search", "memory.read", "memory.history", "memory.sync_status"] as const
).map(listed);
const GOAT_MEMORY_SOURCE_TOOL_NAME = listed("memory.source_read");
const GOAT_MEMORY_WRITE_TOOL_NAMES: ReadonlyArray<string> = (
  ["memory.upsert", "memory.forget", "memory.revert_resolution"] as const
).map(listed);

/** The memory tools a session without these grants must not offer, by their listed names. */
export const goatMemoryToolsWithout = (memory: {
  readonly read: boolean;
  readonly source: boolean;
  readonly write: boolean;
}): ReadonlyArray<string> => [
  ...(!memory.read ? GOAT_MEMORY_READ_TOOL_NAMES : []),
  ...(!memory.source ? [GOAT_MEMORY_SOURCE_TOOL_NAME] : []),
  ...(!memory.write ? GOAT_MEMORY_WRITE_TOOL_NAMES : []),
];

const CLAUDE_GOAT_TOOL_PREFIX = "mcp__goat__";
const claude = (name: string) => `${CLAUDE_GOAT_TOOL_PREFIX}${name}`;

/** The name Claude Code calls a GOAT tool by, given any of its names: the server, then the listed name. */
export const claudeGoatToolName = (name: string) => {
  const entry = resolveAgentSurfaceEntry(name);
  return claude(entry === undefined ? name : listedToolName(entry));
};

/** A Claude allowedTools entry with any GOAT tool it names by its listed name; others unchanged. */
export const claudeAllowedToolName = (tool: string) =>
  tool.startsWith(CLAUDE_GOAT_TOOL_PREFIX)
    ? claudeGoatToolName(tool.slice(CLAUDE_GOAT_TOOL_PREFIX.length))
    : tool;

// Automatic approval policy is separate from Tool.Readonly metadata.
// Preserve html_render preapproval; reading another thread still requires approval.
export const CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = (
  [
    "provider.list",
    "schedule.list",
    "thread.list",
    "thread.wait",
    "thread.status",
    "thread.watch_list",
    "pending_request.list",
    "pending_request.read",
    "thread.configuration_read",
    "thread.transfers",
    "worktree.status",
    "worktree.list",
    "worktree.inventory",
    "project.list",
    "project.read",
    "thread.search",
    "preview.list",
    "environment.read",
    "host.status",
    "provider.diagnose",
    "queue.list",
    "queue.read",
    "review_findings.export",
    "html.preview",
    "html.render",
    "surface.describe",
  ] as const
).map((path) => claude(listed(path)));

const CLAUDE_GOAT_CALL = claude(listed("surface.call"));

/**
 * The Claude name of the tool a call runs: for goat_call, the tool its path names, so approval
 * and memory grants judge the target as they judge a direct call; otherwise the tool itself.
 */
export const claudeGoatCallTarget = (toolName: string, toolInput: unknown): string => {
  if (toolName !== CLAUDE_GOAT_CALL || typeof toolInput !== "object" || toolInput === null)
    return toolName;
  const path = "path" in toolInput ? toolInput.path : undefined;
  const entry = typeof path === "string" ? resolveAgentSurfaceEntry(path) : undefined;
  return entry === undefined || entry.resource === "surface"
    ? toolName
    : claude(listedToolName(entry));
};

export const CLAUDE_MEMORY_SOURCE_TOOL = claude(GOAT_MEMORY_SOURCE_TOOL_NAME);
export const CLAUDE_MEMORY_READ_TOOLS: ReadonlyArray<string> = [
  ...GOAT_MEMORY_READ_TOOL_NAMES.map(claude),
  CLAUDE_MEMORY_SOURCE_TOOL,
];
export const CLAUDE_MEMORY_WRITE_TOOLS: ReadonlyArray<string> =
  GOAT_MEMORY_WRITE_TOOL_NAMES.map(claude);

/**
 * The listed Claude name of the GOAT memory tool a call names, by its listed or shipped name, or
 * undefined for any other tool. Memory grants are checked per call, so both names must reach the
 * same check.
 */
export const claudeGoatMemoryTool = (toolName: string): string | undefined => {
  if (!toolName.startsWith(CLAUDE_GOAT_TOOL_PREFIX)) return undefined;
  const entry = resolveAgentSurfaceEntry(toolName.slice(CLAUDE_GOAT_TOOL_PREFIX.length));
  return entry?.resource === "memory" ? claude(listedToolName(entry)) : undefined;
};
