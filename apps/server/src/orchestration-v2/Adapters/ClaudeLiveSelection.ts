import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

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
    (next.effort !== undefined || live.effort === undefined) &&
    live.pinnedAlias === next.pinnedAlias
  );
}

function claudeLiveSelectionFlagSettings(
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

// One live change per process at a time: a reactor change and a steer's change must not interleave.
const locks = new WeakMap<object, Semaphore.Semaphore>();
const lockOf = (query: object) => {
  const existing = locks.get(query);
  if (existing !== undefined) return existing;
  const lock = Semaphore.makeUnsafe(1);
  locks.set(query, lock);
  return lock;
};

// A failed or interrupted update leaves the live identity unknown, so the next turn applies it.
// Untraced: both callers are spans of their own.
const applyUnlocked = Effect.fnUntraced(function* (
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
    Effect.onError(() =>
      Effect.sync(() => {
        live.selection = { ...live.selection, queryIdentity: "" };
      }),
    ),
  );
  if (live.selection.apiModelId !== selection.apiModelId) live.reportedModel = undefined;
  live.selection = selection;
});

export const applyClaudeSelectionLive = Effect.fn("ClaudeLiveSelection.apply")(function* (
  live: ClaudeLiveSelectionTarget,
  selection: CompiledClaudeModelSelection,
) {
  yield* lockOf(live.query).withPermits(1)(applyUnlocked(live, selection));
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
  if (live === null) return;
  // Checked under the lock: a change that waited may no longer apply.
  yield* lockOf(live.query)
    .withPermits(1)(
      Effect.suspend(() =>
        claudeSelectionAppliesToRunningQuery(live, selection, nativeThreadId)
          ? applyUnlocked(live, selection)
          : Effect.void,
      ),
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.claude-live-selection-failed", { cause }),
      ),
    );
});

/** A selection sent with a steer applies to the running turn when the live process can switch to it. */
export function claudeSteerSelection(
  live: {
    readonly selection: CompiledClaudeModelSelection;
    readonly openedPermissionMode: string;
  },
  steer: CompiledClaudeModelSelection | undefined,
  turnPermissionMode: string,
): CompiledClaudeModelSelection | undefined {
  return steer !== undefined &&
    live.selection.queryIdentity !== steer.queryIdentity &&
    canApplyClaudeSelectionLive(live.selection, steer) &&
    (live.selection.apiModelId === steer.apiModelId ||
      live.openedPermissionMode === turnPermissionMode)
    ? steer
    : undefined;
}
