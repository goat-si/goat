import { presentCloudRun, type CloudRunCard } from "@goat/client-runtime/state/cloud-task";
import type { ThreadStructure } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { makeThreadErrorSetter } from "../ChatView.logic";

/** Runs with a cloud retry in flight, across ChatView instances. */
const retryingCloudRunIds = new Set<RunId>();

function cloudRunKey(card: CloudRunCard | null) {
  return card === null
    ? ""
    : JSON.stringify({
        ...card,
        hiddenItemIds: [...card.hiddenItemIds],
        hiddenMessageIds: [...card.hiddenMessageIds],
      });
}

/**
 * The thread's latest cloud run as a timeline card, kept referentially stable while its
 * content is unchanged so the timeline rows do not re-derive on unrelated projection
 * updates, and the Retry action that resends the failed run's prompt.
 */
export function useCloudRun(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projection: ThreadStructure | null;
  // The composer's own gates: operate scope, a follow-up the provider accepts, no send in flight.
  readonly canRetry: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}) {
  const next = presentCloudRun(input.projection);
  const key = cloudRunKey(next);
  const [held, setHeld] = useState({ key, card: next });
  if (held.key !== key) setHeld({ key, card: next });
  const card = held.key === key ? held.card : next;
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  const retry = useStableCallback(async (runId: RunId) => {
    const request = card?.retry;
    const threadId = input.threadId;
    if (!request || request.runId !== runId || threadId === null) return;
    // One resend per failed run: once it lands, the new run makes this one non-latest.
    if (retryingCloudRunIds.has(runId)) return;
    retryingCloudRunIds.add(runId);
    input.setThreadError(threadId, null);
    const result = await startThreadTurn({
      environmentId: input.environmentId,
      input: {
        threadId,
        modelSelection: request.modelSelection,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: request.text,
          attachments: request.attachments,
        },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        dispatchMode: "start",
      },
    }).finally(() => retryingCloudRunIds.delete(runId));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      input.setThreadError(
        threadId,
        error instanceof Error ? error.message : "Could not retry the cloud run.",
      );
    }
  });

  return { cloudRun: card, onRetryCloudRun: input.canRetry ? retry : null };
}
