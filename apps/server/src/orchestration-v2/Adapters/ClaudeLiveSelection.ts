import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";

import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";
import type {
  ClaudeAgentSdkQuerySession,
  ClaudeFlagSettings,
} from "./ClaudeAgentSdkQueryRunner.ts";

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

export interface ClaudeLiveSelectionTarget {
  readonly query: Pick<ClaudeAgentSdkQuerySession, "setModel" | "applyFlagSettings">;
  selection: CompiledClaudeModelSelection;
  reportedModel: string | undefined;
}

/** A failure leaves the live identity unknown, so the next turn applies the selection again. */
export const applyClaudeSelectionLive = Effect.fn("ClaudeLiveSelection.apply")(function* (
  live: ClaudeLiveSelectionTarget,
  selection: CompiledClaudeModelSelection,
) {
  // Preserve launcher-selected models unless the model changed or a failed update left it unknown.
  yield* (
    live.selection.queryIdentity === "" || live.selection.apiModelId !== selection.apiModelId
      ? live.query.setModel(selection.apiModelId)
      : Effect.void
  ).pipe(
    Effect.andThen(live.query.applyFlagSettings(claudeLiveSelectionFlagSettings(selection))),
    Effect.tapError(() =>
      Effect.sync(() => {
        live.selection = { ...live.selection, queryIdentity: "" };
      }),
    ),
  );
  if (live.selection.apiModelId !== selection.apiModelId) live.reportedModel = undefined;
  live.selection = selection;
});

/** Between turns only effort and fast mode move live; a model change waits for the turn that checks it. */
export function claudeSelectionAppliesToRunningQuery(
  live: {
    readonly stopping: boolean;
    readonly nativeThreadId: string;
    readonly selection: CompiledClaudeModelSelection;
  },
  selection: CompiledClaudeModelSelection,
  nativeThreadId: string | null | undefined,
): boolean {
  return (
    !live.stopping &&
    live.nativeThreadId === nativeThreadId &&
    live.selection.queryIdentity !== selection.queryIdentity &&
    live.selection.apiModelId === selection.apiModelId &&
    canApplyClaudeSelectionLive(live.selection, selection)
  );
}

/** Between turns; a failure is logged and the next turn applies the selection. */
export const applyClaudeSelectionToRunningQuery = Effect.fn(
  "ClaudeLiveSelection.applyToRunningQuery",
)(function* (
  live:
    | (ClaudeLiveSelectionTarget & Parameters<typeof claudeSelectionAppliesToRunningQuery>[0])
    | null,
  selection: CompiledClaudeModelSelection,
  nativeThreadId: string | null | undefined,
) {
  if (live === null || !claudeSelectionAppliesToRunningQuery(live, selection, nativeThreadId))
    return;
  yield* applyClaudeSelectionLive(live, selection).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("orchestration-v2.claude-live-selection-failed", { cause }),
    ),
  );
});
