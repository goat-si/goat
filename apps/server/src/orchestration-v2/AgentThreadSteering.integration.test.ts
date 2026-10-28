import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  driver,
  instanceId,
  projectId,
  threadId,
  senderThreadId,
  agentMessageId,
  harness,
  awaitDomainEvent,
  providerTurnFor,
  reportRunning,
  reportCompleted,
  startTarget,
  send,
  agentMessageRunId,
} from "./AgentThreadSteering.testkit.ts";

// A message one thread's agent sends to another thread joins the target's
// turn like steering, whatever mode the sender named. A turn that cannot take
// steering yet receives the message as soon as it can, not after it ends.

it("maps a thread send's mode to how it is delivered", () => {
  const other = ThreadId.make("thread:other");
  const mode = (
    requested: "auto" | "queue" | "steer" | "restart" | undefined,
    sender: ThreadId | undefined,
  ) =>
    ThreadManagementService.threadSendMode({
      requested,
      senderThreadId: sender,
      targetThreadId: threadId,
    });
  // Another thread's agent: every mode but restart is delivered like steering.
  assert.equal(mode(undefined, other), "steer_when_ready");
  assert.equal(mode("auto", other), "steer_when_ready");
  assert.equal(mode("queue", other), "steer_when_ready");
  assert.equal(mode("steer", other), "steer_when_ready");
  assert.equal(mode("restart", other), "restart");
  // A thread's own follow-ups and outside clients keep queue and steer.
  assert.equal(mode("queue", threadId), "queue");
  assert.equal(mode("steer", undefined), "steer");
  assert.equal(mode("queue", undefined), "queue");
  assert.equal(mode("auto", undefined), "steer_when_ready");
});

it.effect("an agent's message joins a running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("running", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();

        const sent = yield* send();
        yield* worker.drain();
        assert.equal(sent.delivery, "steered");
        assert.equal(sent.run.id, started[0]!.runId);
        assert.deepEqual(
          steered.map((turn) => turn.message.messageId),
          [agentMessageId],
        );
        assert.equal(started.length, 1);

        // A retry of the same send reports that delivery and delivers nothing new.
        const retried = yield* send();
        yield* worker.drain();
        assert.equal(retried.delivery, "steered");
        assert.equal(retried.run.id, started[0]!.runId);
        assert.equal(steered.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message to a starting turn joins it once the turn runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("starting", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);

        const sending = yield* send().pipe(Effect.forkScoped);
        yield* reportRunning(events, started[0]!);
        const sent = yield* Fiber.join(sending);
        yield* worker.drain();

        assert.equal(sent.delivery, "steered");
        assert.equal(sent.run.id, started[0]!.runId);
        assert.deepEqual(
          steered.map((turn) => turn.message.messageId),
          [agentMessageId],
        );
        assert.equal(started.length, 1);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(projection.runs.some((run) => run.status === "queued"));
        assert.equal(
          projection.messages.find((message) => message.id === agentMessageId)?.senderThreadId,
          senderThreadId,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message starts an idle thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, started, steered, layer } = yield* harness("idle", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started, true);
        const sent = yield* send();
        yield* worker.drain();
        assert.equal(sent.delivery, "started");
        assert.equal(started[0]?.message.messageId, agentMessageId);
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message to a settling turn runs as the next turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("settling", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();
        // The provider turn ended; the run waits for its checkpoint.
        yield* reportCompleted(events, started[0]!);

        const sent = yield* send();
        assert.equal(sent.delivery, "queued");
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.deepEqual(steered, []);
        assert.equal(started[1]?.message.messageId, agentMessageId);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message restarts the turn on a provider that steers by restarting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, interrupted, layer } = yield* harness(
        "restart-steering",
        { supportsActiveSteering: false, restartSteering: true },
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();

        const sent = yield* send("steer_when_ready");
        yield* worker.drain();
        assert.equal(sent.delivery, "steered");
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.deepEqual(
          interrupted.map((turn) => turn.providerTurnId),
          [ProviderTurnId.make("provider-turn:" + started[0]!.attemptId)],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message waits for a provider that cannot steer at all", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, interrupted, layer } = yield* harness("unsupported", {
        supportsActiveSteering: false,
        restartSteering: false,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();

        const sent = yield* send("steer_when_ready");
        yield* worker.drain();
        assert.equal(sent.delivery, "queued");
        assert.deepEqual(steered, []);
        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 1);

        yield* reportCompleted(events, started[0]!);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.equal(started[1]?.message.messageId, agentMessageId);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's goal command runs as its own turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("goal", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();
        const sent = yield* send("steer_when_ready", "/goal ship the fix");
        assert.equal(sent.delivery, "queued");
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a stop before the turn runs fails the waiting send", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, started, steered, layer } = yield* harness("stopped", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);

        const sending = yield* send().pipe(Effect.flip, Effect.forkScoped);
        // Let the send reach its wait for the starting turn.
        yield* TestClock.adjust(1);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        const error = yield* Fiber.join(sending);
        yield* worker.drain();
        assert.equal(error._tag, "ThreadManagementTargetStoppedError");
        assert.deepEqual(steered, []);
        assert.equal(yield* agentMessageRunId, undefined);
        assert.equal(started.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a waiting message does not queue behind a turn Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, started, layer } = yield* harness("stopped-before-queue", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        const queueBehindStart = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-behind:" + id),
            threadId,
            messageId: MessageId.make("message:queue-behind:" + id),
            senderThreadId,
            text: "update from the sender thread",
            attachments: [],
            dispatchMode: { type: "queue_after_active", behindRunId: started[0]!.runId },
            createdBy: "agent",
            creationSource: "mcp",
          });

        // While the turn is still starting, the message queues behind it.
        yield* queueBehindStart("before-stop");
        let projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.messages.find((message) => message.id === "message:queue-behind:before-stop")
            ?.runId,
          projection.runs.find((run) => run.status === "queued")?.id,
        );

        // A Stop that lands between the send's last look and its queue dispatch
        // refuses the queue, so the message cannot start a turn after the Stop.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        const error = yield* queueBehindStart("after-stop").pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        yield* worker.drain();
        projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isUndefined(
          projection.messages.find((message) => message.id === "message:queue-behind:after-stop"),
        );
        assert.equal(started.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a message queued behind a slow start still joins the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("slow-start", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);

        const sending = yield* send().pipe(Effect.forkScoped);
        yield* TestClock.adjust(ThreadManagementService.STEER_READY_WAIT_MS + 1);
        const sent = yield* Fiber.join(sending);
        assert.equal(sent.delivery, "queued");
        assert.equal(sent.run.status, "queued");

        const promoted = yield* awaitDomainEvent(
          (event) =>
            event.type === "message.updated" &&
            event.payload.id === agentMessageId &&
            event.payload.runId === started[0]!.runId,
        );
        yield* reportRunning(events, started[0]!);
        yield* Fiber.join(promoted);
        yield* worker.drain();
        assert.deepEqual(
          steered.map((turn) => turn.message.messageId),
          [agentMessageId],
        );
        assert.equal(started.length, 1);

        // A wait on the queued run the send returned follows the message into the turn.
        yield* reportCompleted(events, started[0]!);
        yield* worker.drain();
        const waited = yield* threads.waitForThread({
          projectId,
          threadId,
          runId: sent.run.id,
          timeoutMs: 1,
        });
        assert.equal(waited.run?.id, started[0]!.runId);
        assert.equal(waited.run?.status, "completed");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent's message keeps the running turn's selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, interrupted, layer } = yield* harness("selection", {
        supportsActiveSteering: true,
        restartSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();
        // The user picks another model for the next turn while this one runs.
        const nextTurn: ModelSelection = { instanceId, model: "next-model" };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("next-selection"),
          threadId,
          modelSelection: nextTurn,
        });

        const sent = yield* send();
        yield* worker.drain();
        assert.equal(sent.delivery, "steered");
        assert.deepEqual(interrupted, []);
        assert.equal(steered.map((turn) => turn.message.messageId)[0], agentMessageId);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(projection.thread.modelSelection, nextTurn);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("another thread's restart still restarts on the saved selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, interrupted, layer } = yield* harness("restart", {
        supportsActiveSteering: true,
        restartSteering: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();
        const nextTurn: ModelSelection = { instanceId, model: "next-model" };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("next-selection"),
          threadId,
          modelSelection: nextTurn,
        });

        // restart keeps its meaning: it restarts the turn on the saved selection.
        const sent = yield* send("restart");
        yield* worker.drain();
        assert.equal(sent.delivery, "restarted");
        assert.equal(interrupted.length, 1);
        assert.equal(started.length, 2);
        assert.deepEqual(sent.run.modelSelection, nextTurn);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("internal senders that queue still queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("internal-queue", {
        supportsActiveSteering: true,
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* startTarget(cwd, started);
        yield* reportRunning(events, started[0]!);
        yield* worker.drain();
        const sent = yield* send("queue");
        yield* worker.drain();
        assert.equal(sent.delivery, "queued");
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an unattended message queued behind a slow start keeps its own turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, events, started, steered, layer } = yield* harness("slow-start-unattended", {
        supportsActiveSteering: true,
        computerUse: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        // The promotion watcher runs on its own fiber; its gate decision is the point to wait for.
        const gated = yield* Deferred.make<void>();
        const gateLogger = Logger.make(({ message }) => {
          if (JSON.stringify(message).includes("waits as the next turn"))
            Deferred.doneUnsafe(gated, Effect.void);
        });
        yield* startTarget(cwd, started);

        // A channel worker (unattended by its id) messages a person's turn that starts slowly.
        const sending = yield* send(
          "steer_when_ready",
          "use the screen",
          ThreadId.make("channel-worker:slow-start"),
        ).pipe(
          Effect.provide(Logger.layer([gateLogger], { mergeWithExisting: true })),
          Effect.forkScoped,
        );
        yield* TestClock.adjust(ThreadManagementService.STEER_READY_WAIT_MS + 1);
        const sent = yield* Fiber.join(sending);
        assert.equal(sent.delivery, "queued");

        // The turn becomes steerable; the promotion watcher must leave the message queued
        // instead of steering it into the person's turn.
        const promoted = yield* awaitDomainEvent(
          (event) =>
            event.type === "message.updated" &&
            event.payload.id === agentMessageId &&
            event.payload.runId === started[0]!.runId,
        );
        const ended = yield* awaitDomainEvent(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === started[0]!.runId &&
            event.payload.status === "waiting",
        );
        yield* reportRunning(events, started[0]!);
        yield* Effect.raceFirst(Deferred.await(gated), Fiber.join(promoted));
        yield* worker.drain();
        assert.deepEqual(steered, []);

        const now = yield* DateTime.now;
        const providerTurn = {
          ...providerTurnFor(started[0]!, now),
          status: "completed" as const,
          completedAt: now,
        };
        yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          runOrdinal: started[0]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(ended);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, agentMessageId);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.notEqual(
          projection.messages.find((message) => message.id === agentMessageId)?.runId,
          started[0]!.runId,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
