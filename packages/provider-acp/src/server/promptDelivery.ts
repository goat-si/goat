import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

// pi-agent-core agents (oh-my-pi) end a turn while background work runs and reject
// prompts until it finishes; the prompt is resent rather than failing the turn.
function isAgentBusyPromptError(error: EffectAcpErrors.AcpError): boolean {
  return (
    error._tag === "AcpRequestError" && error.errorMessage.startsWith("Agent is already processing")
  );
}

export function sendPromptWhenIdle<A>(
  turn: { readonly interrupted: boolean; readonly finalized: boolean },
  prompt: () => Effect.Effect<A, EffectAcpErrors.AcpError>,
): Effect.Effect<A, EffectAcpErrors.AcpError> {
  // A Stop can land during the wait, so the flags are rechecked before each resend.
  const stopped = () => turn.interrupted || turn.finalized;
  return prompt().pipe(
    Effect.catchIf(
      (error) => isAgentBusyPromptError(error) && !stopped(),
      (error) =>
        Effect.sleep("1 second").pipe(
          Effect.andThen(
            Effect.suspend(() =>
              stopped() ? Effect.fail(error) : sendPromptWhenIdle(turn, prompt),
            ),
          ),
        ),
    ),
  );
}
