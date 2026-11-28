import { isSideChatThread, type OrchestrationV2AppThread } from "@goat/contracts";

/**
 * Whether a Resume carries context that goes ahead of a prompted turn: a side chat's note, a
 * restart's report of cancelled work, or a restart note. Such a Resume can continue as a
 * prompted turn when the session cannot resume natively.
 */
export const pendingResumeContext = (
  thread: Pick<OrchestrationV2AppThread, "sideChatOf">,
  noteContinuation: boolean,
  restartCancelledWork: ReadonlyArray<unknown>,
) => isSideChatThread(thread) || noteContinuation || restartCancelledWork.length > 0;
