import * as Effect from "effect/Effect";
import type { OrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import type { ProviderTurnControlServiceV2 } from "../ProviderTurnControlService.ts";
import type { ProviderTurnStartServiceV2Shape } from "../ProviderTurnStartTypes.ts";
import { OrchestrationEffectExecutionError } from "./EffectExecution.ts";
import { makeRestartCleanup, makeStartEffect } from "./StartEffect.ts";

export function makeRestartEffect(input: {
  readonly provider: ProviderTurnStartServiceV2Shape;
  readonly control: ProviderTurnControlServiceV2["Service"];
  readonly sessions: ProviderSessionManagerV2["Service"];
}) {
  const start = makeStartEffect(input.provider);
  const cleanup = makeRestartCleanup(input.provider);
  return (
    effect: OrchestrationEffectV2 & {
      readonly request: Extract<
        OrchestrationEffectV2["request"],
        { readonly type: "provider-turn.restart" }
      >;
    },
    willRetry: boolean,
  ) => {
    const request = effect.request;
    const context = {
      threadId: effect.threadId,
      runId: request.runId,
      effectId: effect.id,
      willRetry,
    };
    return cleanup(
      context,
      input.control
        .interruptAndAwaitTerminal({
          threadId: effect.threadId,
          providerSessionId: request.providerSessionId,
          providerThreadId: request.providerThreadId,
          providerTurnId: request.providerTurnId,
          interruptedAttemptId: request.interruptedAttemptId,
          ...(request.sessionTransition?.type === "replace"
            ? {
                replacementProviderSessionId:
                  request.sessionTransition.replacementProviderSessionId,
              }
            : {}),
        })
        .pipe(
          Effect.andThen(
            request.sessionTransition?.type === "replace"
              ? input.sessions.detach({
                  providerSessionId: request.providerSessionId,
                  threadId: effect.threadId,
                  detail: "Selection change requires a provider session restart.",
                })
              : request.sessionTransition?.type === "detach"
                ? input.sessions.detach({
                    providerSessionId: request.providerSessionId,
                    threadId: effect.threadId,
                    detail: "Provider thread handoff replaced this session binding.",
                  })
                : Effect.void,
          ),
        ),
    ).pipe(
      Effect.andThen(start(context)),
      Effect.mapError(
        (cause) =>
          new OrchestrationEffectExecutionError({
            effectId: effect.id,
            effectType: request.type,
            cause,
          }),
      ),
    );
  };
}
