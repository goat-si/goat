import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

// Regression: a steer that restarts a completion wake run left its cohort claimed forever, so a
// sibling result that landed after the restart never woke the parent again.
const restartCompletionWake = Effect.fn("restartCompletionWake")(function* (
  harness: Pick<
    Effect.Success<ReturnType<typeof nextTurnSelectionHarness>>,
    "events" | "started" | "startFirstTurn"
  >,
  siblingFinishesFirst: boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* harness.startFirstTurn;
  const watchRun = (runId: string, status: string) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  const watchTurnRunning = (ordinal: number) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.payload.status === "running" &&
          event.payload.ordinal === ordinal,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  const finishTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      const providerTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
        (candidate) => candidate.runAttemptId === turn.attemptId,
      )!;
      const settled = yield* watchRun(turn.runId, "waiting");
      yield* Queue.offer(harness.events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          ...providerTurn,
          status: "completed",
          completedAt: yield* DateTime.now,
        },
      });
      yield* Queue.offer(harness.events, {
        type: "turn.terminal",
        driver,
        providerThreadId: providerTurn.providerThreadId,
        providerTurnId: providerTurn.id,
        runOrdinal: turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(settled);
      yield* worker.drain();
    });

  const origin = harness.started[0]!;
  const firstTaskId = NodeId.make("task:steered-wake-first");
  const siblingTaskId = NodeId.make("task:steered-wake-sibling");
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [firstTaskId, siblingTaskId].map((taskId) => ({
      id: EventId.make(`event:seed:${taskId}`),
      type: "subagent.updated" as const,
      threadId,
      runId: origin.runId,
      nodeId: taskId,
      occurredAt: now,
      payload: {
        id: taskId,
        threadId,
        runId: origin.runId,
        parentNodeId: origin.rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: null,
        remote: { host: "box", threadId: null, correlationId: `rr-${taskId}` },
        nativeTaskRef: null,
        prompt: "Do background work",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: { state: "pending" as const, observedByRunId: null },
        memoryGrantCeiling: "none" as const,
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    })),
  });
  yield* finishTurn(origin);

  const completeTask = (taskId: NodeId) =>
    orchestrator.dispatch({
      type: "delegated_task.remote.result",
      commandId: CommandId.make(`command:remote-complete:${taskId}`),
      parentThreadId: threadId,
      taskId,
      correlationId: `rr-${taskId}`,
      status: "completed",
      summary: `${taskId} finished`,
    });
  yield* completeTask(firstTaskId);
  const firstDelivery = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
    (run) => run.id === origin.runId,
  )!.delegatedCompletion!.delivery!;
  assert.deepEqual(firstDelivery.taskIds, [firstTaskId]);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("command:first-wake"),
    threadId,
    messageId: firstDelivery.messageId,
    text: "Delegated task completed",
    attachments: [],
    modelSelection: runSelection,
    dispatchMode: { type: "queue_after_active" },
    delegatedCompletion: {
      parentRunId: origin.runId,
      generation: firstDelivery.generation,
      taskIds: firstDelivery.taskIds,
    },
    createdBy: "agent",
    creationSource: "server",
  });
  const wakeRunning = yield* watchTurnRunning(2);
  yield* orchestrator.resumeQueuedRuns;
  yield* worker.drain();
  yield* Fiber.join(wakeRunning);
  const wake = harness.started[1]!;
  assert.equal(wake.message.messageId, firstDelivery.messageId);

  if (siblingFinishesFirst) {
    yield* completeTask(siblingTaskId);
  }

  // The provider cannot steer natively, so the steer restarts the wake run.
  const steeredRunning = yield* watchTurnRunning(3);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("command:steer-wake"),
    threadId,
    messageId: MessageId.make("message:steer-wake"),
    text: "also check the logs",
    attachments: [],
    modelSelection: runSelection,
    dispatchMode: { type: "steer_active", targetRunId: wake.runId },
    createdBy: "user",
    creationSource: "web",
  });
  yield* worker.drain();
  yield* Fiber.join(steeredRunning);
  const steered = harness.started[2]!;
  assert.equal(steered.runId, wake.runId);
  assert.equal(
    (yield* orchestrator.getThreadProjection(threadId)).attempts.find(
      (attempt) => attempt.id === steered.attemptId,
    )?.reason,
    "steering_restart",
  );
  return {
    threadId,
    origin,
    wake,
    steered,
    firstTaskId,
    siblingTaskId,
    watchRun,
    finishTurn,
    completeTask,
  };
});

it.effect("wakes the parent for a sibling result after a steer restarts the completion wake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* nextTurnSelectionHarness(
        "steered-completion-wake",
        true,
        Effect.void,
        false,
        undefined,
        false,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const {
          threadId,
          origin,
          wake,
          steered,
          firstTaskId,
          siblingTaskId,
          watchRun,
          finishTurn,
          completeTask,
        } = yield* restartCompletionWake(harness, false);

        // A follow-up queued behind the wake starts once the terminal-run listener has settled it.
        const followUp = MessageId.make("message:follow-up");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:follow-up"),
          threadId,
          messageId: followUp,
          text: "follow up",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const followUpRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === followUp,
        )!;
        const followUpStarted = yield* watchRun(followUpRun.id, "starting");
        yield* finishTurn(steered);
        yield* Fiber.join(followUpStarted);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === wake.runId,
          )?.status,
          "completed",
        );

        yield* completeTask(siblingTaskId);
        const final = yield* orchestrator.getThreadProjection(threadId);
        const tasks = new Map(
          final.subagents.map((task) => [task.id, task.completionDelivery?.state]),
        );
        assert.deepInclude(
          final.runs.find((run) => run.id === origin.runId)?.delegatedCompletion?.delivery ?? {},
          { generation: 2, taskIds: [siblingTaskId] },
          "the sibling finished after the steered wake but no new completion wake was reserved",
        );
        assert.equal(tasks.get(siblingTaskId), "claimed");
        assert.equal(
          tasks.get(firstTaskId),
          "delivered",
          "the steered wake run's own task stays claimed after that run completed",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "offers the next completion wake when a steer restarts a wake a sibling finished behind",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* nextTurnSelectionHarness(
          "steered-completion-wake-behind",
          true,
          Effect.void,
          false,
          undefined,
          false,
        );
        const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
        const requests = Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { threadId, origin, firstTaskId, siblingTaskId } = yield* restartCompletionWake(
            harness,
            true,
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const delivery = projection.runs.find((run) => run.id === origin.runId)
            ?.delegatedCompletion?.delivery;
          assert.deepInclude(delivery ?? {}, { generation: 2, taskIds: [siblingTaskId] });
          const tasks = new Map(
            projection.subagents.map((task) => [task.id, task.completionDelivery?.state]),
          );
          assert.equal(tasks.get(firstTaskId), "delivered");
          assert.equal(tasks.get(siblingTaskId), "claimed");
          assert.deepEqual(offers.at(-1)?.delegatedCompletion, {
            parentRunId: origin.runId,
            generation: 2,
            messageId: delivery!.messageId,
          });
        }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(requests))));
      }),
    ),
);

// Codex flushes held drafts after the final answer; reserve their pre-steer position before turn end.
