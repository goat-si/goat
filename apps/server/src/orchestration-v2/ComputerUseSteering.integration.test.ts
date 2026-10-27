import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { computerUseOrigin, projectionOriginReads } from "../cua/ComputerUseOrigin.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  threadId,
  harness,
  reportRunning,
  startTarget,
  send,
  askByMessage,
} from "./AgentThreadSteering.testkit.ts";

// Messages, promotions and answers that would join a running turn are weighed against how much
// of the screen that turn may use; less reach waits as the next turn (ComputerUseSteering).

it.effect.each([
  // Choosing to promote is the person's own decision, whoever wrote the queued message.
  { by: "a person's client", path: "dispatch", promoted: true },
  // An agent's promotion is held to the same reach as a steer; the server's own automatic
  // promotion is gated too (AgentThreadSteering: an unattended message queued behind a slow start).
  { by: "an agent", path: "promoteQueuedToSteer", promoted: false },
] as const)(
  "a promotion by $by of an unattended message into a person's running turn",
  ({ path, promoted }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, events, started, steered, layer } = yield* harness("promote-" + path, {
          supportsActiveSteering: true,
          computerUse: true,
        });
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* startTarget(cwd, started);
          yield* reportRunning(events, started[0]!);
          yield* worker.drain();
          const sent = yield* send(
            "steer_when_ready",
            "use the screen",
            ThreadId.make("channel-worker:promote"),
          );
          yield* worker.drain();
          assert.equal(sent.delivery, "queued");

          const result = yield* threads[path]({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-unattended"),
            threadId,
            queuedRunId: sent.run.id,
            targetRunId: started[0]!.runId,
          }).pipe(Effect.result);
          yield* worker.drain();
          assert.equal(result._tag, promoted ? "Success" : "Failure");
          assert.equal(steered.length, promoted ? 1 : 0);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            projection.runs.find((run) => run.id === sent.run.id)?.status,
            promoted ? "cancelled" : "queued",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

const agent = (thread: string, environmentId: string | null) =>
  ({
    type: "agent",
    threadId: ThreadId.make(thread),
    environmentId: environmentId === null ? null : EnvironmentId.make(environmentId),
    title: null,
    reason: "Relaying another thread's reply",
  }) as const;

it.effect.each([
  {
    label: "an unattended thread's answer",
    respondedBy: agent("channel-worker:answer", null),
    via: "service",
    origin: "sent_by_unattended",
  },
  // Another computer's agent counts as remote work: less than the person's turn it would join.
  {
    label: "another computer's agent's answer",
    respondedBy: agent("thread:elsewhere", "elsewhere"),
    via: "service",
    origin: "launched_remotely",
  },
  // Under the dispatch lock only a turn the check approved may take an agent's answer, so a
  // turn that started after the check, or a caller that skipped it, cannot.
  {
    label: "an agent's answer the steering check did not approve",
    respondedBy: agent("channel-worker:answer", null),
    via: "orchestrator",
    origin: "sent_by_unattended",
  },
] as const)(
  "$label to a question waits behind a person's running turn and keeps its origin",
  ({ respondedBy, via, origin }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, events, started, steered, layer } = yield* harness(
          "answer-" + via + "-" + origin,
          {
            supportsActiveSteering: true,
            computerUse: true,
          },
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* startTarget(cwd, started);
          yield* reportRunning(events, started[0]!);
          yield* worker.drain();
          const requestId = yield* askByMessage;
          const command = {
            type: "runtime-request.respond",
            commandId: CommandId.make("answer"),
            threadId,
            requestId,
            answers: { color: "Blue" },
            respondedBy,
          } as const;
          yield* via === "service" ? threads.dispatch(command) : orchestrator.dispatch(command);
          yield* worker.drain();
          assert.deepEqual(steered, []);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const answer = projection.messages.find((message) => message.text.includes("Blue"));
          assert.isDefined(answer?.runId);
          assert.notEqual(answer?.runId, started[0]!.runId);
          const reads = projectionOriginReads({
            getThreadRecords: (id, fields, filter) =>
              orchestrator.getThreadRecords(id, fields, filter),
            channelOrigin: () => Effect.undefined,
          });
          assert.deepEqual(yield* computerUseOrigin(reads, { threadId, runId: answer!.runId! }), {
            _tag: "unattended",
            reason: origin,
          });
        }).pipe(Effect.provide(layer));
      }),
    ),
);
