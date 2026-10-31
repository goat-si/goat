import type { ScreenHostCall, ScreenHostReply, ScreenRunError, ScreenImage } from "@goat/contracts";

export const imageSize = (image: ScreenImage) => Buffer.from(image.bytes, "base64").byteLength;
export const key = (runId: string, turnId: string, cellId: string) =>
  `${runId}\u0000${turnId}\u0000${cellId}`;
export const replyTargetId = (value: unknown): string | undefined => {
  const reply = typeof value === "object" && value !== null ? value : undefined;
  const ref = reply && "targetRef" in reply ? reply.targetRef : reply;
  return typeof ref === "object" &&
    ref !== null &&
    "id" in ref &&
    typeof ref.id === "string" &&
    "kind" in ref &&
    (ref.kind === "app" || ref.kind === "tab")
    ? ref.id
    : undefined;
};

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
