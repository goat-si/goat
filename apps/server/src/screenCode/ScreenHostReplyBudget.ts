import type { ScreenHostCall, ScreenRunLimits } from "@goat/contracts";

export const observationReplyBudget = (
  call: ScreenHostCall,
  limits: ScreenRunLimits,
  reserveBytes = 0,
): number => {
  const envelope = JSON.stringify({
    t: "reply",
    runId: call.runId,
    cellId: call.cellId,
    callId: call.callId,
    outcome: "ok",
    value: null,
  });
  return Math.min(
    limits.treeBytes,
    limits.returnBytes - (Buffer.byteLength(envelope) - 4) - reserveBytes,
  );
};
