import type { RunId, RunAttemptId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import type { EffectOutboxV2Shape } from "../EffectOutbox.ts";
import type { makeDeferredRecoveryResends } from "./DeferredRecoveryResends.ts";
import {
  MAX_DEFERRED_RECOVERY_RESENDS,
  MAX_RECOVERY_ATTEMPTS,
  MAX_RECOVERY_RESENDS,
} from "./RecoveryResendLimits.ts";

export const selectRecoveryResends = Effect.fn("SelectRecoveryResends.select")(function* (input: {
  readonly projection: ProjectionRuntimeRecoveryState;
  readonly projections: ProjectionStoreV2Shape;
  readonly outbox: EffectOutboxV2Shape;
  readonly deferred: ReturnType<typeof makeDeferredRecoveryResends>;
  readonly preservedRunIds: ReadonlySet<RunId>;
  readonly enabled: boolean;
}) {
  const { projection } = input;
  const deferred = new Set<RunId>();
  const accepted = new Set<RunId>();
  for (const run of projection.runs) {
    if (
      (run.status !== "starting" && run.status !== "running") ||
      input.preservedRunIds.has(run.id) ||
      projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId) ||
      projection.runtimeRequests.some(
        (request) =>
          request.status === "pending" &&
          projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
      )
    )
      continue;
    const attempt = projection.attempts.find((item) => item.id === run.activeAttemptId);
    if (attempt?.inputDelivery !== "unsent") continue;
    const attemptIds: RunAttemptId[] = [];
    let safe = true;
    for (const item of projection.attempts) {
      if (item.runId !== run.id) continue;
      if (item.inputDelivery !== "unsent" || attemptIds.length >= MAX_RECOVERY_ATTEMPTS) {
        safe = false;
        break;
      }
      attemptIds.push(item.id);
    }
    if (!safe) continue;
    const history = yield* input.projections.getThreadRecords(
      projection.thread.id,
      ["providerTurns"],
      { providerTurnAttemptIds: attemptIds, providerTurnLimit: 1 },
    );
    if (
      history.providerTurns.some(
        (turn) => turn.runAttemptId !== null && attemptIds.includes(turn.runAttemptId),
      )
    ) {
      if (accepted.size < MAX_DEFERRED_RECOVERY_RESENDS) accepted.add(run.id);
      continue;
    }
    if (!input.enabled) continue;
    const messages = yield* input.projections.getMessagesById(projection.thread.id, [
      run.userMessageId,
    ]);
    const message = messages.get(run.userMessageId);
    if (
      message === undefined ||
      message.notification !== undefined ||
      message.delegatedCompletion !== undefined ||
      !(
        message.scheduledTaskId !== undefined ||
        (message.createdBy === "agent" && message.creationSource === "mcp")
      )
    )
      continue;
    const original = yield* input.outbox.findOriginalStart(projection.thread.id, run.id);
    if (
      Option.isNone(original) ||
      original.value.resendCount >= MAX_RECOVERY_RESENDS ||
      !input.deferred.reserve({
        threadId: projection.thread.id,
        run,
        attemptId: attempt.id,
        commandId: original.value.commandId,
        resendCount: original.value.resendCount,
      })
    )
      continue;
    deferred.add(run.id);
  }
  return { deferred, accepted };
});
