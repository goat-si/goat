import type { AgentCursorSnapshot, DesktopPreviewCursorEvent } from "@goat/contracts";

export type AgentPointer = {
  readonly key: { readonly threadId: string; readonly tabId: string };
} & (
  | {
      readonly type: "pointer";
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
      readonly cursor?: AgentCursorSnapshot;
    }
  | { readonly type: "cursor-state"; readonly cursor: AgentCursorSnapshot }
);

export function acceptsCursorState(
  previous: AgentCursorSnapshot | undefined,
  next: AgentCursorSnapshot,
): boolean {
  if (previous === undefined) return true;
  const sameOwner =
    previous.identity.environmentId === next.identity.environmentId &&
    previous.identity.runId === next.identity.runId &&
    previous.identity.turnId === next.identity.turnId &&
    previous.identity.targetId === next.identity.targetId &&
    previous.identity.generation === next.identity.generation;
  if (sameOwner)
    return (
      next.identity.sequence > previous.identity.sequence &&
      ((previous.phase !== "hidden" && previous.phase !== "yielded") ||
        next.phase === "hidden" ||
        next.phase === "yielded")
    );
  return (
    previous.phase === "hidden" ||
    previous.phase === "yielded" ||
    next.identity.generation > previous.identity.generation
  );
}

export function acceptsPointerCursor(
  previous: AgentCursorSnapshot | undefined,
  next: AgentCursorSnapshot,
): boolean {
  return (
    acceptsCursorState(previous, next) ||
    (previous !== undefined &&
      previous.phase !== "hidden" &&
      previous.phase !== "yielded" &&
      previous.phase === next.phase &&
      previous.identity.environmentId === next.identity.environmentId &&
      previous.identity.runId === next.identity.runId &&
      previous.identity.turnId === next.identity.turnId &&
      previous.identity.targetId === next.identity.targetId &&
      previous.identity.generation === next.identity.generation &&
      previous.identity.sequence === next.identity.sequence)
  );
}

export const acceptsLegacyPointer = (previous: AgentCursorSnapshot | undefined): boolean =>
  previous === undefined || previous.phase === "hidden" || previous.phase === "yielded";

/** Whether a pointer may draw on its tab; an admitted owner becomes the tab's owner. */
export function admitAgentPointer(
  owners: Map<string, AgentCursorSnapshot>,
  tabId: string,
  pointer: AgentPointer,
): boolean {
  const previous = owners.get(tabId);
  if (pointer.cursor === undefined) return acceptsLegacyPointer(previous);
  if (
    !(pointer.type === "pointer"
      ? acceptsPointerCursor(previous, pointer.cursor)
      : acceptsCursorState(previous, pointer.cursor))
  )
    return false;
  owners.set(tabId, pointer.cursor);
  return true;
}

export function pointerEvent(
  pointer: AgentPointer,
  tabId: string,
  sequence: number,
  createdAt: string,
): DesktopPreviewCursorEvent {
  return pointer.type === "cursor-state"
    ? { type: "cursor-state", tabId, cursor: pointer.cursor, sequence, createdAt }
    : {
        tabId,
        phase: pointer.phase,
        x: pointer.x,
        y: pointer.y,
        sequence,
        createdAt,
        ...(pointer.cursor ? { cursor: pointer.cursor } : {}),
      };
}
