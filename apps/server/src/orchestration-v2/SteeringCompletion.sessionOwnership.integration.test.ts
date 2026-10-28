import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

/**
 * A GOAT Bot session thread serves one task per run, so a child's completion wake for task A
 * must never join task B's running turn; on other threads the wake keeps joining the live turn.
 */
it.effect.each([
  {
    name: "session-other-run",
    thread: "goat-bot-session:wake",
    parentRunning: false,
    joins: false,
  },
  { name: "session-own-run", thread: "goat-bot-session:own", parentRunning: true, joins: true },
  { name: "ordinary-other-run", thread: "thread:ordinary-wake", parentRunning: false, joins: true },
])("$name: a delegated completion joins a running turn only where it may", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* nextTurnSelectionHarness(`wake-routing-${testCase.name}`);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(testCase.thread);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        const send = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${id}`),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        // Ends a run's live provider turn the way the provider reports a finished turn.
        const endTurn = (runId: string) =>
          Effect.gen(function* () {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const ending = projection.runs.find((run) => run.id === runId)!;
            const turn = projection.providerTurns.find(
              (candidate) => candidate.runAttemptId === ending.activeAttemptId,
            )!;
            const ended = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === ending.id &&
                event.payload.status !== "running",
            );
            yield* Queue.offer(harness.events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(harness.events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: ending.ordinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(ended);
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make(`project:${testCase.name}`),
          title: "Wake routing",
          modelSelection: runSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: harness.cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const firstRunning = yield* turnRunning();
        yield* send("a");
        yield* worker.drain();
        yield* Fiber.join(firstRunning);
        const a = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;

        // Task A started a child that finished and owes A its result.
        const wakeId = MessageId.make("message:wake");
        const childId = NodeId.make("task:child-of-a");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("wake:cohort"),
              type: "run.updated",
              threadId,
              runId: a.id,
              occurredAt: now,
              payload: {
                ...a,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId: wakeId, taskIds: [childId] },
                },
              },
            },
            {
              id: EventId.make("wake:child"),
              type: "subagent.updated",
              threadId,
              runId: a.id,
              nodeId: childId,
              occurredAt: now,
              payload: {
                id: childId,
                threadId,
                runId: a.id,
                parentNodeId: harness.started[0]!.rootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Look something up",
                title: "Child of A",
                model: null,
                completionWake: "always",
                completionDelivery: { state: "claimed", observedByRunId: null },
                status: "completed",
                result: "found it",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });

        if (!testCase.parentRunning) {
          // A's turn ends while its child is still owed; task B's run then takes the session.
          yield* endTurn(a.id);
          const secondRunning = yield* turnRunning();
          yield* send("b");
          yield* worker.drain();
          yield* Fiber.join(secondRunning);
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const running = before.runs.find((run) => run.status === "running")!;

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("wake"),
          threadId,
          messageId: wakeId,
          text: "child finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: a.id, generation: 1, taskIds: [childId] },
        });
        yield* worker.drain();

        const after = yield* orchestrator.getThreadProjection(threadId);
        const wake = after.messages.find((message) => message.id === wakeId);
        assert.lengthOf(harness.steered, testCase.joins ? 1 : 0);
        if (testCase.joins) {
          assert.strictEqual(wake?.runId, running.id);
          assert.lengthOf(after.runs, before.runs.length);
          return;
        }
        // The wake waits as its own run; B's turn never sees A's result.
        assert.notStrictEqual(wake?.runId, running.id);
        const wakeRun = after.runs.find((run) => run.id === wake?.runId);
        assert.strictEqual(wakeRun?.status, "queued");
        assert.deepStrictEqual(wake?.delegatedCompletion?.parentRunId, a.id);

        // Once B ends, A's wake starts as its own turn.
        yield* endTurn(running.id);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        const wakeTurn = harness.started.find((turn) => turn.message.messageId === wakeId);
        assert.strictEqual(wakeTurn?.runId, wakeRun?.id);
        assert.lengthOf(harness.steered, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);
