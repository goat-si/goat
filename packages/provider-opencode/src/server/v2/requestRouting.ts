import { isOrchestrationV2WorkActive } from "@goat/contracts";
import type { SubagentCall, ThreadState } from "./adapterState.ts";

const canOwnRequest = (call: SubagentCall) =>
  call.background && isOrchestrationV2WorkActive(call.status) && !call.turn.awaitingStart;

export function makeRequestTurn({
  ownerOf,
  callsAbove,
  callsAttachedTo,
  isExecuting,
}: {
  ownerOf: (sessionId: string) => ThreadState | undefined;
  callsAbove: (sessionId: string) => ReadonlyArray<SubagentCall>;
  callsAttachedTo: (child: ThreadState) => ReadonlyArray<SubagentCall>;
  isExecuting: (sessionId: string) => boolean;
}) {
  return (sessionId: string) => {
    const state = ownerOf(sessionId);
    if (state === undefined) return;
    const ancestors = callsAbove(sessionId);
    // A child can ask while its result still has multiple possible owners.
    for (const anchor of ancestors.toReversed()) {
      if (canOwnRequest(anchor)) return { state, turn: anchor.turn };
      const sibling =
        anchor.child === undefined
          ? undefined
          : callsAttachedTo(anchor.child).findLast(canOwnRequest);
      if (sibling !== undefined) return { state, turn: sibling.turn };
    }
    if (ancestors.some((call) => call.background) && !isExecuting(sessionId)) return;
    return state.active === undefined ? undefined : { state, turn: state.active };
  };
}
