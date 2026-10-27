import { compareSemverVersions, parseSemver } from "@goat/shared/semver";
import type * as Schema from "effect/Schema";

// openai/codex 2f19a57704 (0.147.0) keeps a boolean `features.multi_agent_v2` enabled when a table
// overlays it. Earlier releases drop the boolean, so the v2 cap would switch the feature off.
const CODEX_MULTI_AGENT_V2_CAP_VERSION = "0.147.0";
// `agents.enabled` arrived in 0.145.0 (03bb3b1236); older Codex rejects unknown `agents` keys.
const CODEX_AGENTS_ENABLED_VERSION = "0.145.0";

/** Codex settings that hold native subagents to the thread's goatclaw `maxLanes`. */
export function codexNativeSubagentConfig(
  limit: number | undefined,
  codexVersion: string | undefined,
): {
  readonly config: Readonly<Record<string, Schema.Json>>;
  readonly omitted: ReadonlyArray<string>;
} {
  if (limit === undefined) return { config: {}, omitted: [] };
  const supports = (minimum: string) =>
    codexVersion !== undefined &&
    parseSemver(codexVersion) !== null &&
    compareSemverVersions(codexVersion, minimum) >= 0;
  if (limit === 0) {
    // Model metadata can choose multi-agent v2 by itself; only `agents.enabled = false` overrides
    // that, and an enabled v2 feature overrides `agents.enabled`.
    const off = { "features.multi_agent": false, "features.multi_agent_v2": false };
    return supports(CODEX_AGENTS_ENABLED_VERSION)
      ? { config: { ...off, "agents.enabled": false }, omitted: [] }
      : { config: off, omitted: ["agents.enabled"] };
  }
  // V1 reads `agents.max_threads` as is. V2 counts the root thread, and an explicit v2 cap in the
  // user's config outranks the `agents` fallback.
  const threads = { "agents.max_threads": limit };
  return supports(CODEX_MULTI_AGENT_V2_CAP_VERSION)
    ? {
        config: {
          ...threads,
          "features.multi_agent_v2.max_concurrent_threads_per_session": limit + 1,
        },
        omitted: [],
      }
    : { config: threads, omitted: ["features.multi_agent_v2.max_concurrent_threads_per_session"] };
}
