import { recoveryParkMarkerId } from "./RecoveryParkMarker.ts";
import type {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { EventSinkV2 } from "../EventSink.ts";
import type { ProjectionStoreV2 } from "../ProjectionStore.ts";
import type { ThreadCommandExecutor } from "../ThreadCommandExecutor.ts";
import { MAX_DEFERRED_RECOVERY_RESENDS } from "./RecoveryResendLimits.ts";

type Candidate = {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly attemptId: RunAttemptId;
  readonly commandId: CommandId;
  readonly resendCount: number;
  sequence?: number;
};

export function makeDeferredRecoveryResends(input: {
  readonly projections: ProjectionStoreV2["Service"];
  readonly sink: EventSinkV2["Service"];
  readonly ids: IdAllocatorV2["Service"];
}) {
  const candidates = new Map<string, Candidate>();
  const reserve = (candidate: Candidate) => {
    const key = JSON.stringify([candidate.threadId, candidate.run.id]);
    if (candidates.has(key)) return true;
    if (candidates.size >= MAX_DEFERRED_RECOVERY_RESENDS) return false;
    candidates.set(key, candidate);
    return true;
  };
  const captureSequence = Effect.fn("DeferredRecoveryResends.captureSequence")(function* (
    threadId: ThreadId,
  ) {
    const sequence = yield* input.sink.latestSequence({ threadId });
    for (const candidate of candidates.values())
      if (candidate.threadId === threadId && candidate.sequence === undefined)
        candidate.sequence = sequence;
  });
  const drain = Effect.fn("DeferredRecoveryResends.drain")(function* (
    locks: ThreadCommandExecutor["Service"],
  ) {
    for (const [key, candidate] of candidates) {
      yield* locks
        .withLock(
          candidate.threadId,
          Effect.gen(function* () {
            if (candidate.sequence === undefined) return;
            const changed =
              (yield* input.sink.latestSequence({ threadId: candidate.threadId })) !==
              candidate.sequence;
            const projection = yield* input.projections.getTurnStartContext(
              candidate.threadId,
              candidate.run.id,
            );
            const run = projection.runs.find((item) => item.id === candidate.run.id);
            const attempt = projection.attempts.find((item) => item.id === candidate.attemptId);
            const node = projection.nodes.find((item) => item.id === run?.rootNodeId);
            if (
              run === undefined ||
              run.status !== candidate.run.status ||
              run.activeAttemptId !== candidate.attemptId ||
              run.rootNodeId !== candidate.run.rootNodeId ||
              attempt?.inputDelivery !== "unsent" ||
              node === undefined ||
              projection.attempts.some(
                (item) => item.runId === run.id && item.inputDelivery !== "unsent",
              ) ||
              projection.providerTurns.some((turn) => turn.runAttemptId === attempt.id) ||
              projection.turnItems.some(
                (item) => item.runId === run.id && item.type === "run_interrupt_request",
              )
            )
              return;
            const now = yield* DateTime.now;
            const changes = [
              {
                type: "run.updated" as const,
                payload: changed
                  ? {
                      ...run,
                      status: "queued" as const,
                      startedAt: null,
                      queueHeld: true,
                      queuePosition:
                        projection.runs.reduce(
                          (max, item) => Math.max(max, item.queuePosition ?? 0),
                          0,
                        ) + 1,
                    }
                  : { ...run, status: "starting" as const, startedAt: null },
              },
              {
                type: "run-attempt.updated" as const,
                payload: { ...attempt, status: "pending" as const, startedAt: null },
              },
              {
                type: "node.updated" as const,
                payload: { ...node, status: "pending" as const, startedAt: null },
              },
            ];
            const events: Array<OrchestrationV2DomainEvent> = yield* Effect.forEach(
              changes,
              (change) =>
                input.ids.allocate.event({ threadId: candidate.threadId }).pipe(
                  Effect.map((id) => ({
                    ...change,
                    id,
                    threadId: candidate.threadId,
                    runId: run.id,
                    nodeId: node.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: now,
                  })),
                ),
            );
            if (changed) {
              const ordinal = yield* input.projections.getNextTurnItemOrdinal(candidate.threadId);
              events.push({
                id: yield* input.ids.allocate.event({ threadId: candidate.threadId }),
                type: "turn-item.updated",
                threadId: candidate.threadId,
                runId: run.id,
                nodeId: node.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: recoveryParkMarkerId(run.id),
                  threadId: candidate.threadId,
                  runId: run.id,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  status: "waiting",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "system_notice",
                  severity: "warning",
                  message: "Recovery needs your decision before this message can be sent again.",
                },
              });
            }
            yield* input.sink.writeIfRunCurrent({
              threadId: candidate.threadId,
              runId: run.id,
              activeAttemptId: attempt.id,
              expectedStatus: run.status,
              events,
              effects: changed
                ? []
                : [
                    {
                      id: `effect:recovery-resend:${run.id}:${candidate.resendCount + 1}`,
                      commandId: candidate.commandId,
                      threadId: candidate.threadId,
                      request: { type: "provider-turn.start", runId: run.id },
                    },
                  ],
            });
          }),
        )
        .pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));
            const errorTag =
              Predicate.hasProperty(error, "_tag") && typeof error._tag === "string"
                ? error._tag
                : "defect";
            return Effect.logError("Deferred recovery start failed", {
              threadId: candidate.threadId,
              runId: candidate.run.id,
              errorTag,
            });
          }),
        );
      candidates.delete(key);
    }
  });
  return { reserve, captureSequence, drain };
}
