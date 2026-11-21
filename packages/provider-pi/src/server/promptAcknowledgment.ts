import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Pi acknowledges a prompt after its input handlers finish; a handler that never does must not hold a start forever. */
const PROMPT_ACKNOWLEDGMENT_BOUND = "2 minutes";

export const PROMPT_ACKNOWLEDGMENT_TIMEOUT_DETAIL =
  "Pi has not confirmed your previous message after 2 minutes, so this one was not sent. A Pi extension may still be handling it. Send again to keep waiting, or restart the agent session.";

/** GOAT's own words, so the thread shows them (provider-core's curated failure messages). */
export class PiPromptAcknowledgmentTimeoutError extends Schema.TaggedError<PiPromptAcknowledgmentTimeoutError>()(
  "PiPromptAcknowledgmentTimeoutError",
  {},
) {
  override get message(): string {
    return PROMPT_ACKNOWLEDGMENT_TIMEOUT_DETAIL;
  }
}

/**
 * Waits for Pi to acknowledge earlier prompts. When the bound runs out while a Pi dialog is open,
 * the person is answering it, so the bound starts again; otherwise the start fails with onTimeout.
 */
export const awaitPromptAcknowledgment = Effect.fnUntraced(function* <E, T>(
  drained: Deferred.Deferred<void, E>,
  hasOpenDialog: () => boolean,
  onTimeout: (cause: PiPromptAcknowledgmentTimeoutError) => T,
) {
  while (true) {
    const acknowledged = yield* Deferred.await(drained).pipe(
      Effect.timeoutOption(PROMPT_ACKNOWLEDGMENT_BOUND),
    );
    if (Option.isSome(acknowledged)) return;
    if (!hasOpenDialog())
      return yield* Effect.fail(onTimeout(new PiPromptAcknowledgmentTimeoutError()));
  }
});
