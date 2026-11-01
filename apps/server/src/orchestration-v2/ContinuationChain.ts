import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";

/** Maximum automatic continuation ancestry resolved before requiring a new user turn. */
export const MAX_CONTINUATION_CHAIN = 3;

/**
 * The run and message a restart or usage-limit continuation chain started from, which is
 * where the person's authority and requests for the turn live. Undefined when the chain is
 * broken or longer than {@link MAX_CONTINUATION_CHAIN}.
 */
export function continuationOrigin<Message>(input: {
  readonly run: OrchestrationV2Run;
  readonly message: Message;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
}): { run: OrchestrationV2Run; message: Message | OrchestrationV2ConversationMessage } | undefined {
  let run = input.run;
  let message: Message | OrchestrationV2ConversationMessage = input.message;
  for (let depth = 0; ; depth++) {
    const sourceId = run.restartContinuationOfRunId ?? run.usageLimitContinuationOfRunId;
    if (sourceId === undefined) return { run, message };
    if (depth >= MAX_CONTINUATION_CHAIN) return undefined;
    const source = input.projection.runs.find((candidate) => candidate.id === sourceId);
    const sourceMessage = input.projection.messages.find(
      (candidate) => candidate.id === source?.userMessageId,
    );
    if (source === undefined || sourceMessage === undefined) return undefined;
    run = source;
    message = sourceMessage;
  }
}
