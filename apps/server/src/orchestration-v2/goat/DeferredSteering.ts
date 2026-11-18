import {
  CommandId,
  latestProviderTurnForAttempt,
  parseGoalCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { runResumableReactor } from "../../backgroundSupervision.ts";
import type { EventSinkV2Shape } from "../EventSinkShape.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import type { ThreadCommandExecutor } from "../ThreadCommandExecutor.ts";
import { isNativeMaintenanceCommand, type CommandPolicyV2 } from "../CommandPolicy.ts";
import type { OrchestratorDispatchError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import { worktreeSetupPending } from "./OrchestratorRunState.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";

type Promote = Extract<OrchestrationV2ServerCommand, { type: "queued-message.promote-to-steer" }>;

export function steeringMessageRefusal(
  message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">,
): string | undefined {
  if (isNativeMaintenanceCommand(message)) {
    return message.text.trim().toLowerCase() === "/compact"
      ? "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish."
      : "Signing out must run as a separate turn. Queue it or wait for the active turn to finish.";
  }
  if (parseGoalCommand(message) !== null)
    return "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.";
}

function steerSetupAttempt(
  run: OrchestrationV2Run | undefined,
  providerTurns: readonly OrchestrationV2ProviderTurn[],
) {
  if (run === undefined || run.activeAttemptId === null) return;
  if (run.status === "preparing" || run.status === "starting") return run.activeAttemptId;
  if (run.status !== "running") return;
  const turn = latestProviderTurnForAttempt(
    providerTurns.filter((candidate) => candidate.nodeId === run.rootNodeId),
    run.activeAttemptId,
  );
  if (turn === undefined || turn.status === "pending") return run.activeAttemptId;
}

export const makeDeferSteerDuringSetup = (input: {
  readonly providerAdapters: Pick<ProviderAdapterRegistryV2["Service"], "get">;
  readonly commandPolicy: Pick<CommandPolicyV2["Service"], "decideSteeringExecution">;
  readonly stopReachedRun: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, OrchestratorDispatchError>;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
}) =>
  Effect.fn("Orchestrator.deferSteerDuringSetup")(function* (
    command: OrchestrationV2ServerCommand,
    message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">,
    target: OrchestrationV2Run | undefined,
    turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  ) {
    const attemptId = steerSetupAttempt(target, turns);
    if (
      target === undefined ||
      attemptId === undefined ||
      (yield* input.stopReachedRun(command, target.threadId, target.id))
    )
      return;
    const refuse = (cause: unknown) =>
      new input.OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    const refusal = steeringMessageRefusal(message);
    if (refusal !== undefined) return yield* refuse(refusal);
    const adapter = yield* input.providerAdapters
      .get(target.providerInstanceId)
      .pipe(Effect.mapError(refuse));
    const capabilities = yield* adapter.getCapabilities().pipe(Effect.mapError(refuse));
    yield* input.commandPolicy
      .decideSteeringExecution({
        commandId: command.commandId,
        threadId: target.threadId,
        providerInstanceId: target.providerInstanceId,
        capabilities,
      })
      .pipe(Effect.mapError(refuse));
    return attemptId;
  });

export const holdUndeliveredSteers = Effect.fn("Orchestrator.holdUndeliveredSteers")(function* (
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const held = runs.filter(
    (run) =>
      run.status === "queued" &&
      run.queueHeld !== true &&
      run.steerWhenReadyAttemptId !== undefined,
  );
  if (held.length === 0) return [];
  const now = yield* DateTime.now;
  return held.map(
    (
      run,
    ): Omit<OrchestrationV2DomainEvent, "id"> & {
      type: "run.updated";
      payload: OrchestrationV2Run;
    } => ({
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, queueHeld: true },
    }),
  );
});

export function deferredSteerTarget(queued: OrchestrationV2Run, target?: OrchestrationV2Run) {
  const attemptId = queued.steerWhenReadyAttemptId;
  if (queued.queueHeld === true || attemptId === undefined || target?.activeAttemptId !== attemptId)
    return;
  return {
    queuedRunId: queued.id,
    targetRunId: target.id,
    attemptId,
    queuePosition: queued.queuePosition ?? queued.ordinal,
  };
}

type RestoreDeferredSteer = Extract<
  OrchestrationV2ServerCommand,
  { type: "deferred-steer.restore" }
>;

export const makeRestoreDeferredSteer = (deps: {
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
}) =>
  Effect.fn("Orchestrator.restoreDeferredSteer")(function* (
    command: RestoreDeferredSteer,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const mapError = deps.mapDispatchError(command);
    const projection = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["runs", "attempts", "nodes", "messages", "turnItems"], {
        runIds: [command.queuedRunId],
        ancestryRunIds: [command.queuedRunId],
        messageIds: [command.messageId],
        turnItemRunId: command.targetRunId,
        turnItemTypes: ["user_message"],
      })
      .pipe(mapError);
    const restored = yield* restoredDeferredSteerEvents(command, projection).pipe(mapError);
    for (const event of restored) yield* deps.emit(events, command)(event);
  });

const restoredDeferredSteerEvents = Effect.fn("Orchestrator.restoredDeferredSteerEvents")(
  function* (
    command: RestoreDeferredSteer,
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "attempts" | "nodes" | "messages" | "turnItems"
    >,
  ) {
    const run = projection.runs.find((row) => row.id === command.queuedRunId);
    const message = projection.messages.find((row) => row.id === command.messageId);
    if (
      projection.thread.deletedAt !== null ||
      run?.terminationCause?.kind !== "queued_replaced" ||
      run.status !== "cancelled" ||
      run.userMessageId !== message?.id ||
      message.runId !== command.targetRunId
    )
      return [];
    const attempt = projection.attempts.find((row) => row.id === run.activeAttemptId);
    const node = projection.nodes.find((row) => row.id === run.rootNodeId);
    const item = projection.turnItems.find(
      (row) => row.type === "user_message" && row.messageId === message.id,
    );
    if (attempt === undefined || node === undefined || item?.type !== "user_message") {
      return yield* Effect.fail("Promoted setup steer is missing its queue or turn records");
    }
    const now = yield* DateTime.now;
    const envelope = {
      threadId: run.threadId,
      runId: run.id,
      nodeId: node.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
    };
    return [
      {
        ...envelope,
        type: "run.updated",
        payload: {
          ...run,
          status: "queued",
          terminationCause: undefined,
          queuePosition: command.queuePosition,
          queueHeld: true,
          steerWhenReadyAttemptId: command.attemptId,
          completedAt: null,
        },
      },
      {
        ...envelope,
        type: "run-attempt.updated",
        payload: { ...attempt, status: "pending", completedAt: null },
      },
      {
        ...envelope,
        type: "node.updated",
        payload: { ...node, status: "pending", completedAt: null },
      },
      {
        ...envelope,
        type: "message.updated",
        payload: { ...message, runId: run.id, nodeId: node.id, updatedAt: now },
      },
      {
        ...envelope,
        type: "turn-item.updated",
        payload: {
          ...item,
          runId: run.id,
          nodeId: node.id,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          inputIntent: "queued_turn",
          status: "pending",
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        },
      },
    ] as const;
  },
);

const makeDeliverDeferredSteers = <E, R>(input: {
  readonly projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
  readonly locks: ThreadCommandExecutor["Service"];
  readonly dispatch: (command: Promote) => Effect.Effect<unknown, E, R>;
}) =>
  Effect.fn("Orchestrator.deliverDeferredSteers")(
    function* ({ event }: OrchestrationV2StoredEvent) {
      if (
        event.type !== "provider-turn.updated" ||
        event.payload.status !== "running" ||
        event.payload.survivingRestart !== undefined
      )
        return;
      const { threadId } = event;
      const turn = event.payload;
      yield* input.locks.withLock(
        threadId,
        Effect.gen(function* () {
          const projection = yield* input.projections.getThreadRecords(threadId, ["runs"], {
            runStatuses: ["queued", "running"],
          });
          const run = projection.runs.find(
            (candidate) =>
              candidate.activeAttemptId === turn.runAttemptId &&
              candidate.rootNodeId === turn.nodeId &&
              candidate.status === "running" &&
              candidate.startHold === undefined,
          );
          if (run === undefined) return;
          const pending = queuedRunsInDeliveryOrder({ ...projection, messages: [] }).filter(
            (queued) =>
              queued.queueHeld !== true && queued.steerWhenReadyAttemptId === turn.runAttemptId,
          );
          for (const [index, queued] of pending.entries()) {
            if (index > 0) {
              const current = yield* input.projections.getThreadRecords(threadId, ["runs"], {
                runIds: [run.id],
              });
              const target = current.runs[0];
              if (target?.activeAttemptId !== turn.runAttemptId || target.status !== "running")
                return;
            }
            yield* input
              .dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(
                  `command:deferred-steer:${queued.id}:${turn.runAttemptId}`,
                ),
                threadId,
                queuedRunId: queued.id,
                targetRunId: run.id,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not deliver a deferred steer", {
                    threadId,
                    runId: queued.id,
                    cause,
                  }),
                ),
              );
          }
        }),
      );
    },
    (effect, { event: { threadId } }) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read deferred steers", { threadId, cause }),
        ),
      ),
  );

export const runDeferredSteeringReactor = <E, R>(
  afterSequence: number,
  eventSink: Pick<EventSinkV2Shape, "stream">,
  input: Parameters<typeof makeDeliverDeferredSteers<E, R>>[0],
) =>
  runResumableReactor(
    "Orchestrator.deferredSteering",
    afterSequence,
    (afterSequence) =>
      eventSink
        .stream({ afterSequence, eventType: "provider-turn.updated" })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
        ),
    makeDeliverDeferredSteers(input),
  );

export const makeReleaseUnattendedHolds = <E>(
  projectionStore: Pick<ProjectionStoreV2Shape, "getHeldQueuedRuns" | "getThreadRecords">,
  writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, E>,
) => {
  // A hold waits for a person to review what they queued. Nobody reviews messages from agents,
  // the server or scheduled tasks, so a later completed run releases those unless it was stopped.
  return Effect.fn("Orchestrator.releaseUnattendedHolds")(function* (
    threadId: ThreadId,
    completedRunId: RunId,
  ) {
    const held = yield* projectionStore.getHeldQueuedRuns(threadId);
    if (held.length === 0) return;
    const projection = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      {
        messageIds: held.map((run) => run.userMessageId),
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [completedRunId],
      },
    );
    // Only the newest run completing shows the thread moved past the hold; a late or
    // bookkeeping update to an older run, overtaken by a failure or Stop, does not.
    if (
      latestExecutedRun(projection.runs)?.id !== completedRunId ||
      projection.turnItems.length > 0 ||
      worktreeSetupPending(projection)
    )
      return;
    const { messages } = projection;
    const unattended = new Set(
      messages
        .filter((message) => message.createdBy !== "user" || message.scheduledTaskId !== undefined)
        .map((message) => message.id),
    );
    const now = yield* DateTime.now;
    const released = held.filter(
      (run) => run.steerWhenReadyAttemptId === undefined && unattended.has(run.userMessageId),
    );
    if (released.length === 0) return;
    yield* writeSystemEvents(
      released.map((run) => ({
        type: "run.updated" as const,
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, queueHeld: false },
      })),
    );
  });
};
