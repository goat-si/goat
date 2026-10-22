import {
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { OrchestratorProjectionError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export class OrchestratorReviewLedgerError extends Schema.TaggedError<OrchestratorReviewLedgerError>()(
  "OrchestratorReviewLedgerError",
  {
    taskId: NodeId,
    reason: Schema.Literals([
      "task_not_owned",
      "not_review",
      "evidence_required",
      "decision_required",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "task_not_owned":
        return "Review ledger requires an app-owned task of the parent thread.";
      case "not_review":
        return "Review ledger requires a task with role review.";
      case "evidence_required":
        return "Rebutting a critical or high severity finding requires evidence.";
      case "decision_required":
        return "A finding requires an existing decision before an outcome.";
    }
  }
}

/**
 * The Orchestrator closures that the review ledger needs. The Orchestrator passes
 * its error class in so this module never imports it at runtime.
 */
export interface ReviewLedgerDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/**
 * Appends decisions and outcomes to a review task's finding ledger. It has no span
 * of its own: the dispatch span covers it.
 */
export const makeReviewLedger = (deps: ReviewLedgerDeps) => {
  const { projectionStore, emit, isBlockingRun, OrchestratorProjectionError } = deps;

  const dispatchReviewLedgerAppend = Effect.fnUntraced(function* (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "delegated_task.review-ledger.append" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.parentThreadId, ["subagents", "runs"])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.parentThreadId, cause }),
        ),
      );
    const task = projection.subagents.find(
      (candidate) =>
        candidate.id === command.taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === command.parentThreadId,
    );
    const refuse = (reason: OrchestratorReviewLedgerError["reason"]) =>
      new OrchestratorReviewLedgerError({ taskId: command.taskId, reason });
    if (task === undefined) return yield* refuse("task_not_owned");
    if (task.role !== "review") return yield* refuse("not_review");
    const now = yield* DateTime.now;
    const ledger = [...(task.reviewLedger ?? [])];
    const observingRun = projection.runs
      .filter(isBlockingRun)
      .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    for (const [index, input] of command.entries.entries()) {
      const recorded = {
        entryId: `review-ledger:${command.commandId}:${index}`,
        recordedAt: DateTime.formatIso(now),
        recordedByRunId: observingRun?.id ?? null,
      };
      if (input.kind === "decision") {
        if (
          input.decision === "rebutted" &&
          (input.severity === "critical" || input.severity === "high") &&
          input.evidence === null
        ) {
          return yield* refuse("evidence_required");
        }
        ledger.push({ ...input, ...recorded });
      } else {
        const decision = ledger.findLast(
          (entry) => entry.kind === "decision" && entry.findingId === input.findingId,
        );
        if (decision?.kind !== "decision") return yield* refuse("decision_required");
        ledger.push({
          ...input,
          ...recorded,
          outcome: decision.decision === "rebutted" ? "later_confirmed" : "unneeded",
        });
      }
    }
    yield* emit(
      events,
      command,
    )({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: { ...task, reviewLedger: ledger, updatedAt: now },
    });
  });

  return { dispatchReviewLedgerAppend };
};
