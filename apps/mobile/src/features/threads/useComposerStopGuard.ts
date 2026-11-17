import { useEffect, useState } from "react";

type StopPhase = "pending" | "timedOut" | "landed" | null;

/**
 * Stop, as on web (useComposerStopState): it shows "Stopping" until the run stops, and the
 * action that takes its place ignores taps for a moment, so a double tap on Stop never resumes.
 * A new run, or another thread in the reused composer, starts with a live Stop.
 */
export function useComposerStopGuard(input: {
  readonly canStop: boolean;
  readonly runId: string | null;
  readonly owner: string;
  readonly canOperateThread: boolean;
  readonly onStop: () => void;
}) {
  const [phase, setPhase] = useState<StopPhase>(null);
  const [stopped, setStopped] = useState({ runId: input.runId, owner: input.owner });
  if (input.owner !== stopped.owner || (input.runId !== null && input.runId !== stopped.runId)) {
    setStopped({ runId: input.runId, owner: input.owner });
    setPhase(null);
  } else if (input.canOperateThread) {
    if ((phase === "pending" || phase === "timedOut") && !input.canStop) setPhase("landed");
    else if (phase === "landed" && input.canStop) setPhase(null);
  }
  // oxlint-disable-next-line goat/react-effect-budget -- allows a retry when a stop never settles, and ends the tap guard
  useEffect(() => {
    if (phase !== "pending" && phase !== "landed") return;
    const timeout =
      phase === "pending"
        ? setTimeout(() => setPhase("timedOut"), 10_000)
        : setTimeout(() => setPhase(null), 500);
    return () => clearTimeout(timeout);
  }, [phase]);
  const stopDisabled = !input.canOperateThread || phase === "pending" || phase === "landed";
  return {
    showStop: input.canStop || phase === "pending" || phase === "timedOut",
    stopDisabled,
    stopLabel: phase === "pending" ? "Stopping agent" : "Stop agent",
    replacementBlocked: phase === "landed",
    stop: () => {
      if (stopDisabled) return;
      setPhase("pending");
      input.onStop();
    },
  };
}
