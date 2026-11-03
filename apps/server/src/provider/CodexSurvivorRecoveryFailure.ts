import { CommandId, ProviderDriverKind } from "@goat/contracts";
import { makeProviderFailureTurnItem } from "@goat/provider-core/server/failure";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as CodexSurvivors from "./CodexSurvivors.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";

export const reportUnverified = Effect.fn("CodexSurvivorRecovery.reportUnverified")(
  function* (input: {
    readonly run: ProjectionStore.ProjectionRuntimeRecoveryState["runs"][number];
    readonly turn: ProjectionStore.ProjectionRuntimeRecoveryState["providerTurns"][number];
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sink: EventSink.EventSinkV2["Service"];
    readonly ids: IdAllocator.IdAllocatorV2["Service"];
  }) {
    const { run, turn } = input;
    if (!run.activeAttemptId || !run.providerThreadId) return;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`command:survivor-unverified:${run.id}:${turn.id}`);
    const item = makeProviderFailureTurnItem({
      driver: ProviderDriverKind.make("codex"),
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: turn.id,
      itemOrdinal: 1,
      occurredAt: now,
      failure: {
        class: "provider_error",
        message:
          "The Codex process for this thread could not be verified. The previous turn may still be running.",
        code: null,
        retryable: false,
      },
    });
    const existing = yield* input.projections.getThreadRecords(run.threadId, ["turnItems"], {
      turnItemRunIds: [run.id],
      turnItemTypes: ["error"],
    });
    if (existing.turnItems.some((value) => value.id === item.id)) return;
    yield* input.sink.writeIfRunCurrent({
      threadId: run.threadId,
      runId: run.id,
      activeAttemptId: run.activeAttemptId,
      expectedStatus: run.status,
      commandId,
      effects: [],
      events: [
        {
          id: yield* input.ids.allocate.event({ threadId: run.threadId, commandId }),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  },
);

export const settleLost = Effect.fn("CodexSurvivorRecovery.settleLost")(function* (input: {
  readonly run: ProjectionStore.ProjectionRuntimeRecoveryState["runs"][number];
  readonly turn: ProjectionStore.ProjectionRuntimeRecoveryState["providerTurns"][number];
  readonly attempt: ProjectionStore.ProjectionRuntimeRecoveryState["attempts"][number] | undefined;
  readonly node: ProjectionStore.ProjectionRuntimeRecoveryState["nodes"][number] | undefined;
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
}) {
  const { run, turn, attempt, node } = input;
  if (!attempt || !run.activeAttemptId || !run.providerThreadId) return false;
  const threadId = run.threadId;
  const now = yield* DateTime.now;
  const commandId = CommandId.make(`command:survivor-lost:${run.id}:${turn.id}`);
  const item = makeProviderFailureTurnItem({
    driver: ProviderDriverKind.make("codex"),
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: turn.id,
    itemOrdinal: 1,
    occurredAt: now,
    failure: {
      class: "provider_error",
      message:
        "The Codex process stopped while the turn that ran across the restart was still running.",
      code: null,
      retryable: false,
    },
  });
  const committed = yield* input.sink.writeIfRunCurrent({
    threadId,
    runId: run.id,
    activeAttemptId: run.activeAttemptId,
    expectedStatus: run.status,
    commandId,
    effects: [],
    events: [
      {
        id: yield* input.ids.allocate.event({ threadId, commandId }),
        type: "provider-turn.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...turn, status: "failed", completedAt: now },
      },
      {
        id: yield* input.ids.allocate.event({ threadId, commandId }),
        type: "run-attempt.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...attempt, status: "failed", completedAt: now },
      },
      {
        id: yield* input.ids.allocate.event({ threadId, commandId }),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          ...run,
          status: "failed",
          completedAt: now,
          terminationCause: { kind: "provider_process_exit" },
        },
      },
      {
        id: yield* input.ids.allocate.event({ threadId, commandId }),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: item,
      },
      ...(node
        ? [
            {
              id: yield* input.ids.allocate.event({ threadId, commandId }),
              type: "node.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...node, status: "failed" as const, completedAt: now },
            },
          ]
        : []),
    ],
  });
  if (!committed.committed) return false;
  const cancelled = yield* input.outbox.cancelContinuations(threadId, [
    run.id,
    ...(run.restartContinuationOfRunId ? [run.restartContinuationOfRunId] : []),
  ]);
  yield* input.outbox.signalCancellations(cancelled);
  return true;
});

export const hasNativeTerminalEvidence = Effect.fn(
  "CodexSurvivorRecovery.hasNativeTerminalEvidence",
)(function* (input: {
  readonly survivors: CodexSurvivors.CodexSurvivors["Service"];
  readonly record: CodexSurvivors.CodexInstanceRecordKey;
  readonly block: CodexSurvivors.CodexStopObligation;
}) {
  const classification = yield* input.survivors.classifyRecord(input.record).pipe(Effect.option);
  if (Option.isNone(classification)) return false;
  if (classification.value.type === "gone") return !classification.value.possibleLeftovers?.length;
  if (classification.value.type !== "verified" || !input.survivors.readExistingTurn) return false;
  const status = yield* input.survivors
    .readExistingTurn(input.record, input.block.nativeThreadId, input.block.nativeTurnId)
    .pipe(Effect.option);
  return Option.isSome(status) && ["completed", "failed", "interrupted"].includes(status.value);
});
