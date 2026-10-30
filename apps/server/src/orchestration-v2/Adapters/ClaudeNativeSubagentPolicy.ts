/** Claude Code reads this cap at every subagent launch (2.1.217 and later); it takes positive integers only. */
const CLAUDE_MAX_CONCURRENT_SUBAGENTS = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";

/**
 * How a Claude process holds native subagents to the thread's goatclaw limit. Claude Code counts
 * running subagents itself; zero removes the Agent tool, which also covers the CLI's internal
 * launches. Both are fixed when the process opens, so `key` joins the query policy key.
 */
export function claudeNativeSubagentPolicy(limit: number | undefined, goatBotSession: boolean) {
  if (goatBotSession || limit === 0)
    return { key: "off", disallowedTools: ["Agent", "Task"], environment: {} } as const;
  if (limit === undefined) return { key: "", environment: {} } as const;
  return {
    key: `cap:${limit}`,
    environment: { [CLAUDE_MAX_CONCURRENT_SUBAGENTS]: String(limit) },
  } as const;
}
