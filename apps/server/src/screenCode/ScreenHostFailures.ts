import type { ScreenHostCall, ScreenHostReply, ScreenRunError } from "@goat/contracts";

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
export const notRun = (callId: number, haltedBy: number): ScreenRunError => ({
  ...failure("not_run", callId),
  nextStep: `Call ${haltedBy} in this cell failed, so this call did not run. Observe in a new cell before acting again.`,
});
