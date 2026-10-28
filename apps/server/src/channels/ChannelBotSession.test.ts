import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput, ChannelTask, ChannelTaskId, RunId } from "@goat/contracts";
import {
  isGoatBotSessionThreadId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SESSION_PREFIX_HEADINGS } from "./channelBotSessionBrief.ts";
import * as ChannelBotSession from "./ChannelBotSession.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { taskIdFor, turnSteerIdsFor } from "./channelIds.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" } as const;

/** "look:" starts a GOAT Bot turn, "stop:<task>" stops one, "more:<task> text" follows one up. */
const script = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  if (input.mode === "input" && text.startsWith("look:"))
    return Effect.succeed({
      replyText: "Looking now.",
      action: {
        type: "run_turn" as const,
        title: text.slice(5).trim(),
        instruction: text.slice(5).trim(),
      },
    });
  if (input.mode === "input" && text.startsWith("stop:"))
    return Effect.succeed({
      replyText: "Stopping.",
      action: { type: "stop_work" as const, taskId: text.slice(5).trim() as ChannelTaskId },
    });
  if (input.mode === "input" && text.startsWith("answer:")) {
    const [taskId, questionId, ...answer] = text.slice(7).split(" ");
    return Effect.succeed({
      replyText: "Passing that on.",
      action: {
        type: "answer_question" as const,
        taskId: taskId as ChannelTaskId,
        questionId: questionId as never,
        answer: answer.join(" "),
      },
    });
  }
  if (input.mode === "input" && text.startsWith("more:"))
    return Effect.succeed({
      replyText: "Passing that on.",
      action: { type: "follow_up" as const, taskId: text.slice(5).split(" ")[0] as ChannelTaskId },
    });
  return defaultScript(input);
};

const sessionHarness = () => {
  const harness = makeHarness({
    botWorkspace: true,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
      goatBotModelSelection: botModel,
    }).pipe(Layer.orDie),
  });
  harness.script.current = script;
  return harness;
};

/** One message from the person, read and dispatched, with worker runs reconciled. */
const ask = (text: string, key: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const ingested = yield* gateway.ingest(goatInput(text, key), rpcContext);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    // A stop or follow-up creates no task; callers that started one read it.
    return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))?.task as ChannelTask;
  });

const settle = Effect.gen(function* () {
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  yield* reports.reconcile(runtime.ownerToken);
  yield* runtime.drain;
});

const current = (taskId: ChannelTaskId) =>
  ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) => ledger.getTask(taskId)),
    Effect.map((stored) => stored!.task),
  );

const usage = (fields: Record<string, unknown>) => [
  {
    tokenUsage: {
      usedTokens: 1_000,
      maxTokens: 200_000,
      updatedAt: "1970-01-01T00:00:00.000Z",
      ...fields,
    },
  },
];

/** The thread's run ids in order, and whether a send steered into them. */
const runsOf = (harness: ReturnType<typeof sessionHarness>, threadId: ThreadId) =>
  harness.world.runs.get(threadId) ?? [];

/** A report as the session run with this server-issued run id would make it. */
const reportFrom = (
  task: ChannelTask,
  runId: RunId,
  input: Partial<Parameters<ChannelWorkerReports.ChannelWorkerReports["Service"]["report"]>[0]>,
) =>
  ChannelWorkerReports.ChannelWorkerReports.pipe(
    Effect.flatMap((reports) =>
      reports.report(
        {
          taskId: task.taskId,
          generation: task.generation,
          eventId: "report" as never,
          status: "running",
          summary: "Working.",
          ...input,
        },
        task.worker!.threadId,
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      thread: {
        threadId: task.worker!.threadId,
        providerSessionId: "credential",
        providerInstanceId: botModel.instanceId,
        runId,
      },
    } as never),
  );

describe("GOAT Bot sessions", () => {
  it.effect(
    "runs two requests in one conversation in the same session thread, each as its own run",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const first = yield* ask("look: why is the disk full", "s1");
        const second = yield* ask("look: and the memory", "s2");
        const thread = first.worker!.threadId;
        assert.isTrue(isGoatBotSessionThreadId(thread));
        assert.strictEqual(second.worker?.threadId, thread);
        assert.lengthOf(harness.world.launches, 1);
        const sends = harness.world.sends.filter((send) => send.threadId === thread);
        assert.deepStrictEqual(
          sends.map((send) => send.mode),
          ["queue"],
        );
        const runs = runsOf(harness, thread);
        assert.lengthOf(runs, 2);
        assert.strictEqual(second.worker?.runId, runs[1]!.id);
        // The first run still works, so the second waits as its own run instead of joining it.
        assert.strictEqual(runs[1]!.status, "queued");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "starts generation n+1 with the six-part prefix once the cache is known to be cold",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const first = yield* ask("look: one", "c1");
        const thread = first.worker!.threadId;
        harness.world.providerTurns.set(
          thread,
          usage({ promptCacheExpiresAt: "1970-01-01T00:05:00.000Z" }),
        );
        harness.world.setStatus(thread, 1, "completed", "Done.");
        yield* settle;
        yield* TestClock.adjust("10 minutes");
        const second = yield* ask("look: two", "c2");
        assert.notStrictEqual(second.worker?.threadId, thread);
        assert.isTrue(isGoatBotSessionThreadId(second.worker!.threadId));
        const text = harness.world.launches[1]!.initialMessage!.text;
        const positions = SESSION_PREFIX_HEADINGS.map((heading) => text.indexOf("## " + heading));
        assert.isTrue(positions.every((position) => position >= 0));
        assert.deepStrictEqual(
          positions,
          positions.toSorted((left, right) => left - right),
        );
        assert.include(text.slice(positions[5]!), "two");
        // The tail carries the earlier exchange; the open work the session started with is gone.
        assert.include(text.slice(positions[3]!, positions[4]!), "look: one");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("never rotates on time alone when the cache expiry is unknown", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "u1");
      const thread = first.worker!.threadId;
      harness.world.providerTurns.set(thread, usage({}));
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      yield* TestClock.adjust("1 day");
      const second = yield* ask("look: two", "u2");
      assert.strictEqual(second.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rotates on the context budget, but only once the session's work is done", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "b1");
      const thread = first.worker!.threadId;
      harness.world.providerTurns.set(thread, usage({ usedTokens: 195_000 }));
      // The first run is still using tools: the next request waits instead of rotating under it.
      const waiting = yield* ask("look: two", "b2");
      assert.isUndefined(waiting.worker);
      assert.lengthOf(harness.world.launches, 1);
      assert.lengthOf(harness.world.sends, 0);
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      const rotated = yield* current(waiting.taskId);
      assert.isDefined(rotated.worker);
      assert.notStrictEqual(rotated.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("defers a due rotation while child work the session started is still active", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* ask("look: one", "d1");
      const thread = first.worker!.threadId;
      const admitted = yield* childWork.admit({
        callerThreadId: thread,
        callerRunId: first.worker!.runId,
        surface: "delegate_local",
        prompt: "look deeper",
        destinationKey: "codex",
      });
      if (admitted._tag !== "admitted") return yield* Effect.die("expected admission");
      const childThreadId = ThreadId.make("thread:session-child");
      harness.world.addRun(childThreadId, MessageId.make("msg:session-child"));
      yield* Effect.scoped(childWork.claimLaunch(admitted.record, { threadId: childThreadId }));
      yield* childWork.markBound(admitted.record, { threadId: childThreadId });
      harness.world.providerTurns.set(thread, usage({ usedTokens: 195_000 }));
      harness.world.setStatus(thread, 1, "completed", "Started a child.");
      const waiting = yield* ask("look: two", "d2");
      assert.isUndefined(waiting.worker);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "stops one task's run and children without touching the other task in the session",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const a = yield* ask("look: task a", "t1");
        const b = yield* ask("look: task b", "t2");
        const c = yield* ask("look: task c", "t3");
        const thread = a.worker!.threadId;
        const [runA, runB, runC] = runsOf(harness, thread).map((run) => run.id);
        harness.world.subagents.set(thread, [
          {
            id: "node:child-a",
            runId: runA,
            origin: "app_owned",
            childThreadId: "thread:child-a",
            status: "running",
            completionDelivery: { state: "pending" },
          },
          {
            id: "node:child-b",
            runId: runB,
            origin: "app_owned",
            childThreadId: "thread:child-b",
            status: "running",
            completionDelivery: { state: "pending" },
          },
        ] as never);
        // Stopping the queued task cancels its queued run only.
        yield* ask("stop:" + c.taskId, "t4");
        assert.isTrue(
          harness.world.commands.some(
            (command) => command.type === "queued-run.cancel" && command.runId === runC,
          ),
        );
        // Stopping the running task interrupts its own run and its own child, never B's.
        yield* ask("stop:" + a.taskId, "t5");
        const interrupts = harness.world.commands.filter(
          (command) => command.type === "run.interrupt",
        );
        assert.deepStrictEqual(
          interrupts.map((command) => (command as { runId: RunId }).runId),
          [runA],
        );
        assert.isFalse(
          harness.world.commands.some(
            (command) => command.type === "thread.stop" && command.threadId === thread,
          ),
        );
        assert.deepStrictEqual(harness.world.childStops, [
          { threadId: thread, childThreadIds: ["thread:child-a"] },
        ]);
        const disposed = harness.world.commands.filter(
          (command) => command.type === "delegated_task.completion-delivery.dispose",
        );
        assert.deepStrictEqual(
          disposed.map((command) => (command as { taskId: string }).taskId),
          ["node:child-a"],
        );
        yield* settle;
        assert.strictEqual((yield* current(b.taskId)).status, "running");
        assert.strictEqual(runsOf(harness, thread)[1]!.status, "running");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "ties child work to the run that asked for it, never to the session's later run",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const a = yield* ask("look: task a", "w1");
        const b = yield* ask("look: task b", "w2");
        const thread = a.worker!.threadId;
        const admit = (runId: RunId | undefined, prompt: string) =>
          childWork
            .admit({
              callerThreadId: thread,
              ...(runId === undefined ? {} : { callerRunId: runId }),
              surface: "delegate_local",
              prompt,
              destinationKey: "codex",
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
              Effect.orElseSucceed(() => "admitted"),
            );
        const fromA = yield* childWork.admit({
          callerThreadId: thread,
          callerRunId: a.worker!.runId,
          surface: "delegate_local",
          prompt: "a's lookup",
          destinationKey: "codex",
        });
        assert.strictEqual(fromA._tag === "admitted" ? fromA.record.taskId : undefined, a.taskId);
        // B's run is queued, and a call without a run is never attributed on a shared session.
        assert.strictEqual(yield* admit(b.worker!.runId, "b early"), "run_not_attributable");
        assert.strictEqual(yield* admit(undefined, "no run"), "run_not_attributable");
        // A finishes and B starts; A's delayed call is refused, never booked to B.
        harness.world.setStatus(thread, 1, "completed", "Done.");
        assert.strictEqual(yield* admit(a.worker!.runId, "a late"), "run_not_attributable");
        const fromB = yield* childWork.admit({
          callerThreadId: thread,
          callerRunId: b.worker!.runId,
          surface: "delegate_local",
          prompt: "b's lookup",
          destinationKey: "codex",
        });
        assert.strictEqual(fromB._tag === "admitted" ? fromB.record.taskId : undefined, b.taskId);
        assert.strictEqual(
          fromB._tag === "admitted" ? fromB.record.callerRunId : undefined,
          b.worker!.runId,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses a report from a run that is not the task's newest run", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const a = yield* ask("look: task a", "r1");
      const b = yield* ask("look: task b", "r2");
      const thread = a.worker!.threadId;
      const reportAs = (runId: RunId, eventId: string) =>
        reports
          .report(
            {
              taskId: a.taskId,
              generation: a.generation,
              eventId: eventId as never,
              status: "running",
              summary: "Still looking.",
            },
            thread,
          )
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              thread: {
                threadId: thread,
                providerSessionId: "credential",
                providerInstanceId: botModel.instanceId,
                runId,
              },
            } as never),
            Effect.as("accepted"),
            Effect.catchTags({ ChannelGatewayError: (error) => Effect.succeed(error.reason) }),
          );
      assert.strictEqual(yield* reportAs(b.worker!.runId!, "r-b"), "forbidden");
      assert.strictEqual(yield* reportAs(a.worker!.runId!, "r-a"), "accepted");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "sends a follow-up for a task whose run just ended as that task's next run, not into the next task's",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const a = yield* ask("look: task a", "f1");
        const b = yield* ask("look: task b", "f2");
        const thread = a.worker!.threadId;
        // Recorded while A still runs; A then finishes and B starts before the follow-up is sent.
        const ingested = yield* gateway.ingest(
          goatInput("more:" + a.taskId + " and the logs", "f3"),
          rpcContext,
        );
        yield* reception.receive(ingested.inputId, runtime.ownerToken);
        harness.world.setStatus(thread, 1, "completed", "A done.");
        for (const pending of yield* ledger.listPendingForwards(10))
          yield* dispatcher.forward(pending, runtime.ownerToken);
        const runs = runsOf(harness, thread);
        assert.lengthOf(runs, 3);
        assert.strictEqual(
          runs[2]!.userMessageId,
          turnSteerIdsFor(ingested.inputId, "queued").messageId,
        );
        assert.isFalse([...harness.world.steered.values()].includes(b.worker!.runId!));
        assert.strictEqual((yield* current(a.taskId)).worker?.runId, runs[2]!.id);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "serving a task again after an interrupted pass binds the same run and sends nothing new",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const session = yield* ChannelBotSession.ChannelBotSession;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const a = yield* ask("look: task a", "i1");
        const b = yield* ask("look: task b", "i2");
        // A pass that launched or queued the request but died before binding runs again.
        const stored = (yield* ledger.getTask(a.taskId))!;
        assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "served");
        const again = (yield* ledger.getTask(b.taskId))!;
        assert.strictEqual(yield* session.serve(again, runtime.ownerToken), "served");
        assert.lengthOf(harness.world.launches, 1);
        assert.lengthOf(harness.world.sends, 1);
        assert.lengthOf(runsOf(harness, a.worker!.threadId), 2);
        assert.strictEqual((yield* current(a.taskId)).worker?.runId, a.worker?.runId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("an answer steered into the asking run lifts its fence, so the task can finish", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const a = yield* ask("look: task a", "q1");
      yield* reportFrom(a, a.worker!.runId!, {
        eventId: "ask" as never,
        status: "waiting_input",
        question: "Which disk?",
      });
      const questionId = (yield* current(a.taskId)).openQuestions[0]!.questionId;
      yield* ask("answer:" + a.taskId + " " + questionId + " the big one", "q2");
      const stored = (yield* ledger.getTask(a.taskId))!;
      assert.isUndefined(stored.pendingAnswerMessageId);
      const answer = harness.world.sends.find((send) => send.text.includes("the big one"));
      assert.strictEqual(answer?.mode, "steer");
      assert.strictEqual(answer?.targetRunId, a.worker!.runId);
      harness.world.setStatus(a.worker!.threadId, 1, "completed", "The big one is full.");
      yield* settle;
      assert.strictEqual((yield* current(a.taskId)).status, "completed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("replays an accepted steer onto the run it joined, never as a second run", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* ask("look: task a", "p1");
      yield* ask("look: task b", "p2");
      const thread = a.worker!.threadId;
      const ingested = yield* gateway.ingest(
        goatInput("more:" + a.taskId + " also the swap", "p3"),
        rpcContext,
      );
      yield* reception.receive(ingested.inputId, runtime.ownerToken);
      // The earlier process recorded the steer, the session accepted it, and the process died.
      const ids = turnSteerIdsFor(ingested.inputId, "first");
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${thread}, ${ids.messageId}, ${a.taskId}, ${a.generation}, 'followup', '1970-01-01T00:00:00.000Z')`;
      yield* threads.sendToThread({
        projectId: ProjectId.make(a.target!.projectId),
        commandId: ids.commandId,
        threadId: thread,
        messageId: ids.messageId,
        text: "Follow-up from Owner: also the swap",
        attachments: [],
        mode: "steer",
        targetRunId: a.worker!.runId!,
        createdBy: "user",
        creationSource: "server",
      });
      // A then finishes and B starts before the forward is replayed.
      harness.world.setStatus(thread, 1, "completed", "A done.");
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.lengthOf(runsOf(harness, thread), 2);
      assert.isFalse(
        harness.world.sends.some(
          (send) => send.messageId === turnSteerIdsFor(ingested.inputId, "queued").messageId,
        ),
      );
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never launches a cancelled task's unlaunched session for the next task", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* ask("look: task a", "g1");
      const thread = a.worker!.threadId;
      // As if the process died after allocating A's generation, before its launch intent.
      yield* sql`UPDATE channel_bot_sessions SET state = 'starting' WHERE thread_id = ${thread}`;
      yield* sql`DELETE FROM channel_bot_session_runs WHERE thread_id = ${thread}`;
      harness.world.runs.delete(thread);
      yield* ask("stop:" + a.taskId, "g2");
      const b = yield* ask("look: task b", "g3");
      assert.notStrictEqual(b.worker?.threadId, thread);
      const launch = harness.world.launches.find(
        (candidate) => candidate.threadId === b.worker?.threadId,
      );
      const text = launch!.initialMessage!.text;
      const message = text.slice(text.indexOf("## Current message"));
      assert.include(message, "task b");
      assert.notInclude(message, "task a");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("binds the run a launch committed even when the launch then reports a failure", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      harness.world.failLaunchAfterAccept = true;
      const a = yield* ask("look: task a", "l1");
      assert.isDefined(a.worker?.runId);
      assert.strictEqual(a.status, "running");
      assert.lengthOf(runsOf(harness, a.worker!.threadId), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops a delegate that landed while the stop interrupted the run", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const a = yield* ask("look: task a", "x1");
      const thread = a.worker!.threadId;
      harness.world.afterCommand = (command) => {
        if (command.type !== "run.interrupt") return;
        harness.world.subagents.set(thread, [
          {
            id: "node:late",
            runId: a.worker!.runId,
            origin: "app_owned",
            childThreadId: "thread:late",
            status: "running",
            completionDelivery: { state: "pending" },
          },
        ] as never);
      };
      yield* ask("stop:" + a.taskId, "x2");
      assert.deepStrictEqual(harness.world.childStops, [
        { threadId: thread, childThreadIds: ["thread:late"] },
      ]);
      assert.isTrue(
        harness.world.commands.some(
          (command) =>
            command.type === "delegated_task.completion-delivery.dispose" &&
            command.taskId === "node:late",
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "drops a stopped task's owed wakes even from finished children, but keeps a cloud task's",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const a = yield* ask("look: task a", "y1");
        const thread = a.worker!.threadId;
        for (const [childThread, status] of [
          ["thread:cloud", "running"],
          ["thread:cloud-done", "completed"],
        ] as const) {
          harness.world.addRun(ThreadId.make(childThread), MessageId.make("msg:" + childThread));
          harness.world.cloudTasks.set(childThread, status);
        }
        harness.world.addRun(ThreadId.make("thread:unreadable"), MessageId.make("msg:unreadable"));
        harness.world.recordFailures.add("thread:unreadable");
        const child = (id: string, childThreadId: string, status: string) => ({
          id,
          runId: a.worker!.runId,
          origin: "app_owned",
          childThreadId,
          status,
          completionDelivery: { state: "pending" },
        });
        harness.world.subagents.set(thread, [
          child("node:done", "thread:done", "completed"),
          child("node:cloud", "thread:cloud", "running"),
          child("node:cloud-done", "thread:cloud-done", "completed"),
          child("node:unreadable", "thread:unreadable", "completed"),
        ] as never);
        const disposed = () =>
          [
            ...new Set(
              harness.world.commands.flatMap((command) =>
                command.type === "delegated_task.completion-delivery.dispose"
                  ? [command.taskId]
                  : [],
              ),
            ),
          ].toSorted();
        yield* ask("stop:" + a.taskId, "y2");
        // A recorded cloud task keeps its promised result, finished or not; an unreadable child
        // keeps the stop pending instead of guessing.
        assert.deepStrictEqual(disposed(), ["node:done"]);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
        harness.world.recordFailures.delete("thread:unreadable");
        yield* settle;
        assert.deepStrictEqual(disposed(), ["node:done", "node:unreadable"]);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("puts the serving run on the task's chip", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* ask("look: task a", "h1");
      const b = yield* ask("look: task b", "h2");
      const chips = (yield* botMessages).turnItems.flatMap((item) =>
        item.type === "notification" && item.ledgerTask?.taskId === b.taskId
          ? [item.ledgerTask]
          : [],
      );
      assert.strictEqual(chips.at(-1)?.worker?.runId, b.worker!.runId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a task's approval on that task when a later task's run ends", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const a = yield* ask("look: task a", "v1");
      const b = yield* ask("look: task b", "v2");
      const thread = a.worker!.threadId;
      harness.world.runs.set(
        thread,
        runsOf(harness, thread).map((run, index) => ({
          ...run,
          rootNodeId: NodeId.make("node:run-" + index),
        })),
      );
      harness.world.runtimeRequests.set(thread, [
        {
          id: RuntimeRequestId.make("approval:a"),
          nodeId: NodeId.make("node:run-0"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
          resolvedAt: null,
        } as never,
      ]);
      // B never ran; stopping it makes it the newest run that is not queued.
      yield* ask("stop:" + b.taskId, "v3");
      yield* settle;
      assert.lengthOf((yield* current(a.taskId)).observed?.needsYou ?? [], 1);
      assert.lengthOf((yield* current(b.taskId)).observed?.needsYou ?? [], 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
