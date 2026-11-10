import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Stops the Codex turn no run owns that a sent message waits behind. */
export function useStopHeldTurn(environmentId: EnvironmentId) {
  const stop = useAtomCommand(orchestrationEnvironment.stopHeldTurn);
  const canStopHeldTurn = useAtomValue(
    orchestrationEnvironment.stopHeldTurn.permissionAtom(environmentId),
  );
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const stopHeldTurn = async (threadId: ThreadId) => {
    if (!canStopHeldTurn || stoppingThreadId !== null) return;
    setStoppingThreadId(threadId);
    const result = await stop({ environmentId, input: { threadId } });
    setStoppingThreadId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not stop the Codex turn",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (result.value.outcome === "stopping")
      toastManager.add({
        type: "info",
        title: "Codex is stopping the turn",
        description: "Your message starts once it ends.",
      });
  };
  return { canStopHeldTurn, stoppingThreadId, stopHeldTurn };
}
