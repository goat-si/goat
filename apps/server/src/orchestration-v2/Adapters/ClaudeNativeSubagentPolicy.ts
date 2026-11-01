import { compareSemverVersions, parseSemver } from "@goat/shared/semver";

/** Claude Code reads this cap at every subagent launch (2.1.217 and later); it takes positive integers only. */
const CLAUDE_MAX_CONCURRENT_SUBAGENTS = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";
const CLAUDE_SUBAGENT_CAP_VERSION = "2.1.217";

/** An older or unreadable Claude Code ignores the cap, so a capped process opens without Agent. */
export const claudeIgnoresSubagentCap = (version: string | undefined) =>
  version === undefined ||
  parseSemver(version) === null ||
  compareSemverVersions(version, CLAUDE_SUBAGENT_CAP_VERSION) < 0;

/**
 * How a Claude process holds native subagents to the thread's goatclaw limit. Claude Code counts
 * running subagents itself; zero removes the Agent tool, which also covers internal launches.
 * Fixed at open, so `key` joins the query policy key.
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
