import { latestProviderTurnForAttempt, type RunAttemptId } from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import { cloudTaskResultText } from "@goat/provider-core/server/cloudTask";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeCloudResultEvents } from "../CloudResultEvents.ts";
import type { EventSinkV2 } from "../EventSink.ts";
import type { ProjectionStoreV2 } from "../ProjectionStore.ts";
import type { ProviderTurnStartServiceV2Shape } from "../ProviderTurnStartTypes.ts";

export function makeCloudStartFailureHandler({
  input,
  isAttaching,
  originalAttemptId,
  projectionStore,
  idAllocator,
  eventSink,
}: {
  readonly input: Parameters<ProviderTurnStartServiceV2Shape["start"]>[0];
  readonly isAttaching: () => boolean;
  readonly originalAttemptId: RunAttemptId | null | undefined;
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly eventSink: EventSinkV2["Service"];
}) {
  return <E>(cause: E) =>
    Effect.gen(function* () {
      // A retried start finds the attach run already running and returns, so an
      // attach settles on its first failure.
      if (input.reattach === true ? input.willRetry === true : !isAttaching())
        return yield* Effect.fail(cause);
      const current = yield* projectionStore.getTurnStartContext(input.threadId, input.runId);
      const run = current.runs.find((candidate) => candidate.id === input.runId);
      const thread = current.providerThreads.find(
        (candidate) => candidate.id === run?.providerThreadId,
      );
      const attempt = current.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
      const root = current.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      const attached =
        input.reattach !== true &&
        thread?.cloudTask?.attach === "registered" &&
        thread.cloudTask.acceptedAppRunId === input.runId &&
        thread.firstRunOrdinal === run?.ordinal;
      if (
        (input.reattach !== true && !attached) ||
        run?.status !== "running" ||
        (input.reattach === true && run.activeAttemptId !== originalAttemptId) ||
        !thread?.cloudTask ||
        !attempt ||
        !root
      ) {
        return yield* Effect.fail(cause);
      }
      const now = yield* DateTime.now;
      const reason = attached
        ? "This environment's sign-in cannot follow this cloud run, so GOAT keeps only its link. Open the link for its progress."
        : "Cloud tracking could not be reattached. Open the task link; remote work may continue.";
      const updated = {
        ...thread,
        status: "idle" as const,
        updatedAt: now,
        cloudTask: attached
          ? {
              ...thread.cloudTask,
              tracking: "link-only" as const,
              error: reason,
              updatedAt: DateTime.formatIso(now),
            }
          : {
              ...thread.cloudTask,
              status: "unknown" as const,
              error: reason,
              updatedAt: DateTime.formatIso(now),
            },
      };
      // A link-only registration ends its attach run without claiming a result.
      const settled = attached ? ("completed" as const) : ("failed" as const);
      const allocateEventId = () => idAllocator.allocate.event({ threadId: input.threadId });
      const cloudResultEvents = yield* makeCloudResultEvents({
        run,
        nodeId: root.id,
        providerThreadId: thread.id,
        providerTurnId: latestProviderTurnForAttempt(current.providerTurns, attempt.id)?.id ?? null,
        text: cloudTaskResultText({ ...updated.cloudTask, summary: reason }),
        completedAt: now,
        allocateEventId,
      });
      yield* eventSink.writeIfRunCurrent({
        threadId: input.threadId,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "running",
        events: [
          ...(yield* Effect.forEach(
            [
              { type: "provider-thread.updated" as const, payload: updated },
              {
                type: "run.updated" as const,
                payload: { ...run, status: settled, completedAt: now },
              },
              {
                type: "run-attempt.updated" as const,
                payload: { ...attempt, status: settled, completedAt: now },
              },
              {
                type: "node.updated" as const,
                payload: { ...root, status: settled, completedAt: now },
              },
            ],
            (event) =>
              allocateEventId().pipe(
                Effect.map((id) => ({
                  ...event,
                  id,
                  threadId: input.threadId,
                  runId: run.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                })),
              ),
          )),
          ...cloudResultEvents,
        ],
      });
      return yield* Effect.fail(cause);
    });
}
