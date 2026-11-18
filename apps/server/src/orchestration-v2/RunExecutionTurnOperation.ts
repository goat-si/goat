import type { OrchestrationV2CloudTask } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";

export function providerTurnOperation(
  input: RunExecutionServiceV2StartRootRunInput,
  turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  compact: boolean,
  cloudObservation: { readonly cloudTask: OrchestrationV2CloudTask } | null,
) {
  const { session, providerThread, run } = input;
  const fail = (cause: unknown) =>
    Effect.fail(
      new ProviderAdapter.ProviderAdapterTurnStartError({
        driver: session.driver,
        threadId: run.threadId,
        providerThreadId: providerThread.id,
        runId: run.id,
        cause,
      }),
    );
  if (cloudObservation !== null) {
    const { message: _message, cloudLaunchSource: _source, ...attachInput } = turnInput;
    return (
      session.resumeTurn?.({ ...attachInput, ...cloudObservation }) ??
      fail("This cloud provider cannot reattach observation. Open the saved task link.")
    );
  }
  if (input.resume === true) {
    const { message, cloudLaunchSource: _source, ...resumeInput } = turnInput;
    return (
      session.resumeInterruptedTurn?.({ ...resumeInput, messageId: message.messageId }) ??
      fail(
        new ProviderAdapter.ProviderResumeUnsupportedError({
          driver: session.driver,
          providerThreadId: providerThread.id,
        }),
      )
    );
  }
  if (compact)
    return (
      session.compactThread?.(turnInput) ??
      fail(
        new ProviderAdapter.ProviderCompactionUnsupportedError({
          driver: session.driver,
          providerThreadId: providerThread.id,
        }),
      )
    );
  return session.startTurn(turnInput);
}
