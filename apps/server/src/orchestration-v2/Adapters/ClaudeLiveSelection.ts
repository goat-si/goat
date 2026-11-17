import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";
import type { ClaudeFlagSettings } from "./ClaudeAgentSdkQueryRunner.ts";

/** Thinking requires a new process. Clearing effort also requires one to reload user settings instead of model defaults. */
export function canApplyClaudeSelectionLive(
  live: CompiledClaudeModelSelection,
  next: CompiledClaudeModelSelection,
): boolean {
  return (
    live.settings.alwaysThinkingEnabled === next.settings.alwaysThinkingEnabled &&
    (next.effort !== undefined || live.effort === undefined)
  );
}

export function claudeLiveSelectionFlagSettings(
  selection: CompiledClaudeModelSelection,
): ClaudeFlagSettings {
  return {
    ...(selection.effort === undefined ? {} : { effortLevel: selection.effort as EffortLevel }),
    fastMode: selection.settings.fastMode ?? null,
    ultracode: selection.settings.ultracode ?? null,
  };
}
