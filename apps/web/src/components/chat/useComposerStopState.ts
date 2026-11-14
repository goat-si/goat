import { useEffect, useState } from "react";

export function useComposerStopState(
  runId: string | null,
  canInterrupt: boolean,
  canOperateThread: boolean,
) {
  const [phase, setPhase] = useState<"pending" | "timedOut" | "landed" | null>(null);
  const [stopRunId, setStopRunId] = useState(runId);
  if (runId !== null && stopRunId !== runId) {
    setStopRunId(runId);
    setPhase(null);
  } else if (canOperateThread) {
    if ((phase === "pending" || phase === "timedOut") && !canInterrupt) setPhase("landed");
    else if (phase === "landed" && canInterrupt) setPhase(null);
  }
  // oxlint-disable-next-line goat/react-effect-budget -- allow retry if the stop never settles
  useEffect(() => {
    if (phase !== "pending" && phase !== "landed") return;
    const timeout =
      phase === "pending"
        ? setTimeout(() => setPhase("timedOut"), 10_000)
        : setTimeout(() => setPhase(null), 500);
    return () => clearTimeout(timeout);
  }, [phase]);
  return {
    phase,
    disabled: phase === "pending" || phase === "landed",
    start: () => setPhase("pending"),
  };
}
