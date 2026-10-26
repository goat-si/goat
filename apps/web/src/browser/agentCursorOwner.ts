import type { AgentCursorOwner, AgentCursorSnapshot, AgentCursorState } from "@goat/contracts";

interface OwnedCursorPlacement {
  readonly sequence: number;
  readonly owner?: AgentCursorOwner;
  readonly cursorPhase?: AgentCursorState;
}

/** The owner fields a placed pointer carries when the agent reported one. */
export const agentCursorOwnerFields = (cursor: AgentCursorSnapshot | undefined) =>
  cursor === undefined ? {} : { owner: cursor.identity, cursorPhase: cursor.phase };

/**
 * The drawn cursor after an owner reports its phase: a hidden or yielded phase, or a report from
 * another owner, removes it; its own owner's report keeps the point and takes the new phase.
 */
export function agentCursorAfterState<P extends OwnedCursorPlacement>(
  current: P | null,
  state: AgentCursorSnapshot,
): P | null {
  if (state.phase === "hidden" || state.phase === "yielded") return null;
  return current?.owner !== undefined &&
    current.owner.environmentId === state.identity.environmentId &&
    current.owner.runId === state.identity.runId &&
    current.owner.turnId === state.identity.turnId &&
    current.owner.targetId === state.identity.targetId &&
    current.owner.generation === state.identity.generation
    ? { ...current, sequence: state.identity.sequence, cursorPhase: state.phase }
    : null;
}
