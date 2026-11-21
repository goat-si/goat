import type { OrchestrationV2Run } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MAX_CONTINUATION_CHAIN } from "../ContinuationChain.ts";
import type { EffectOutboxV2 } from "../EffectOutbox.ts";

export const continuationCrashCount = Effect.fn("ContinuationCrashBudget.count")(function* (
  outbox: EffectOutboxV2["Service"],
  run: OrchestrationV2Run,
) {
  if (
    run.restartContinuationOfRunId === undefined ||
    run.status === "completed" ||
    run.status === "waiting"
  )
    return 1;
  const prior = yield* outbox.get(`effect:restart-continuation:${run.restartContinuationOfRunId}`);
  const request = Option.getOrUndefined(prior)?.request;
  return Math.min(
    MAX_CONTINUATION_CHAIN,
    1 + (request?.type === "provider-runtime.continue" ? (request.processLossCount ?? 0) : 0),
  );
});

export const priorContinuationCrashCount = Effect.fn("ContinuationCrashBudget.prior")(function* (
  outbox: EffectOutboxV2["Service"],
  run: OrchestrationV2Run,
) {
  if (run.restartContinuationOfRunId === undefined) return undefined;
  const prior = yield* outbox.get(`effect:restart-continuation:${run.restartContinuationOfRunId}`);
  const request = Option.getOrUndefined(prior)?.request;
  return request?.type === "provider-runtime.continue" ? request.processLossCount : undefined;
});

export const hasPlannedContinuationAncestor = Effect.fn("ContinuationCrashBudget.plannedAncestor")(
  function* (
    outbox: EffectOutboxV2["Service"],
    source: OrchestrationV2Run,
    runs: ReadonlyArray<OrchestrationV2Run>,
  ) {
    let current: OrchestrationV2Run | undefined = source;
    for (
      let depth = 0;
      depth < MAX_CONTINUATION_CHAIN && current?.restartContinuationOfRunId !== undefined;
      depth++
    ) {
      const prior = yield* outbox.get(
        `effect:restart-continuation:${current.restartContinuationOfRunId}`,
      );
      const effect = Option.getOrUndefined(prior);
      if (effect?.commandId.startsWith("command:restart-prepare:")) return true;
      if (
        effect?.request.type === "provider-runtime.continue" &&
        effect.request.processLossCount !== undefined
      )
        return false;
      current = runs.find((run) => run.id === current?.restartContinuationOfRunId);
    }
    return false;
  },
);
