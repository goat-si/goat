/** The bridge's own refusals and the categories that fail a write. */
import type {
  ScreenEffectReceipt,
  ScreenHostCall,
  ScreenHostReply,
  ScreenRunError,
} from "@goat/contracts";

export const failure = (code: ScreenRunError["code"], callId?: number): ScreenRunError => ({
  code,
  ...(callId === undefined ? {} : { callId }),
  effectStarted: false,
  nextStep: "Refresh the screen target and retry if appropriate.",
});
export const refused = (call: ScreenHostCall, error: ScreenRunError): ScreenHostReply => ({
  t: "reply",
  runId: call.runId,
  cellId: call.cellId,
  callId: call.callId,
  outcome: "error",
  error,
});
/** Results that did not do what was asked; a write that answers one fails its call. */
export const FAILED_CATEGORIES: ReadonlySet<ScreenEffectReceipt["category"]> = new Set([
  "partial",
  "suspected_noop",
  "refused",
]);
export const notRun = (callId: number, haltedBy: number): ScreenRunError => ({
  ...failure("not_run", callId),
  nextStep: `Call ${haltedBy} in this cell failed, so this call did not run. Observe in a new cell before acting again.`,
});
