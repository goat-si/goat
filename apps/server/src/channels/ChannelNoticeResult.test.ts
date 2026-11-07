import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput, ChannelTask, RunId } from "@goat/contracts";
import { MessageId, NodeId, ProviderInstanceId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { receptionDecisionChannels } from "./testkit/channelReceptionHarness.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";
import { noticeRunsOf } from "./testkit/harnessMessages.ts";

const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" } as const;

/** The task's session run; a task without one fails the test. */
const sessionRun = (task: ChannelTask): RunId => {
  const runId = task.worker?.runId;
  if (runId === undefined) throw new Error("The task has no session run");
  return runId;
};

const harnessFor = () => {
  const harness = makeHarness({
    botWorkspace: true,
    channelsLayer: receptionDecisionChannels,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
      goatBotModelSelection: botModel,
    }).pipe(Layer.orDie),
  });
  harness.script.current = (input: ChannelReceptionInput) =>
    input.mode === "input" && (input.inputText ?? "").startsWith("also:")
      ? Effect.succeed({
          replyText: "Passing that on.",
          action: {
            type: "follow_up" as const,
            taskId: input.tasks.find((task) => task.status === "running")!.taskId,
          },
        })
      : input.mode === "input" && (input.inputText ?? "").startsWith("look:")
        ? Effect.succeed({
            replyText: "On it.",
            action: { type: "run_turn" as const, title: "Plan the logistics", instruction: "plan" },
          })
        : defaultScript(input);
  return harness;
};

const texts = Effect.map(botMessages, (records) => records.messages.map((message) => message.text));

describe("a background command's notice run is never its request's result", () => {
  it.effect.each([
    ["after the turn's own run ended", false],
    ["while the turn's own run still ran", true],
  ] as const)("settles the turn on its own answer when the notice arrives %s", ([, early]) => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("look: plan the logistics", "n1"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const turn = yield* onlyTask;
      const session = turn.worker!.threadId;
      const own = sessionRun(turn);
      const settleOwn = () =>
        harness.world.setStatus(session, 1, "completed", "Book the van for Friday.");
      if (!early) settleOwn();
      const notice = harness.world.addRun(session, MessageId.make("message:command-notice"));
      noticeRunsOf(harness.world).set(notice.id, own);
      if (early) settleOwn();
      harness.world.setStatus(session, 2, "completed", "The payments key is in the Ops vault.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(turn.taskId))?.task.status, "completed");
      const delivered = yield* texts;
      assert.include(delivered, "Book the van for Friday.");
      assert.notInclude(delivered, "The payments key is in the Ops vault.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("settles the turn on its own answer when the task was bound to the notice run", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("look: plan the logistics", "b1"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const turn = yield* onlyTask;
      const session = turn.worker!.threadId;
      harness.world.setStatus(session, 1, "completed", "Book the van for Friday.");
      const notice = harness.world.addRun(session, MessageId.make("message:command-notice"));
      noticeRunsOf(harness.world).set(notice.id, sessionRun(turn));
      harness.world.setStatus(session, 2, "completed", "The payments key is in the Ops vault.");
      // A recovered send binds the task to its newest owned run, which is the notice.
      const stored = (yield* ledger.getTask(turn.taskId))!;
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.worker.bound",
          payload: { worker: { ...stored.task.worker!, runId: notice.id } },
        },
        { owner: runtime.ownerToken },
      );
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(turn.taskId))?.task.status, "completed");
      assert.include(yield* texts, "Book the van for Friday.");
    }).pipe(Effect.provide(harness.layer));
  });
});
describe("a follow-up while a background command's notice runs", () => {
  it.effect("goes to the task's own next run, never into the notice", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("look: plan the logistics", "f1"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const turn = yield* onlyTask;
      const session = turn.worker!.threadId;
      // Its own run ended, but a coding thread it launched still runs, so the task stays open.
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* childWork.admit({
        callerThreadId: session,
        callerRunId: sessionRun(turn),
        surface: "thread_launch",
        prompt: "keep working in a worktree",
        destinationKey: "codex/gpt-6.1-sol",
      });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      const child = ThreadId.make("thread:still-running");
      harness.world.addRun(child, MessageId.make("msg:still-running"));
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: child }));
      yield* childWork.markBound(admission.record, { threadId: child });
      harness.world.setStatus(session, 1, "completed", "Book the van for Friday.");
      const notice = harness.world.addRun(session, MessageId.make("message:command-notice"));
      noticeRunsOf(harness.world).set(notice.id, sessionRun(turn));
      yield* reports.reconcile(runtime.ownerToken);
      yield* gateway.ingest(goatInput("also: and book a driver", "f2"), rpcContext);
      yield* runtime.drain;
      const send = harness.world.sends.find((candidate) =>
        candidate.text.includes("book a driver"),
      );
      assert.isDefined(send);
      assert.notStrictEqual(send?.targetRunId, notice.id);
      assert.notStrictEqual(harness.world.steered.get(send!.messageId), notice.id);
    }).pipe(Effect.provide(harness.layer));
  });
});
describe("a background command's notice run cannot report for its request", () => {
  it.effect("a task report from the notice is refused while the task's own run still may", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("look: plan the logistics", "r1"), rpcContext);
      yield* runtime.drain;
      yield* reports.reconcile(runtime.ownerToken);
      const turn = yield* onlyTask;
      const session = turn.worker!.threadId;
      const notice = harness.world.addRun(session, MessageId.make("message:command-notice"));
      noticeRunsOf(harness.world).set(notice.id, sessionRun(turn));
      const reportAs = (runId: string, eventId: string) =>
        reports
          .report(
            {
              taskId: turn.taskId,
              generation: turn.generation,
              eventId: eventId as never,
              status: "running",
              summary: "Still looking.",
            },
            session,
          )
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              thread: {
                threadId: session,
                providerSessionId: "credential",
                providerInstanceId: botModel.instanceId,
                runId,
              },
            } as never),
            Effect.as("accepted"),
            Effect.catchTags({ ChannelGatewayError: (error) => Effect.succeed(error.reason) }),
          );
      assert.strictEqual(yield* reportAs(notice.id, "from-notice"), "forbidden");
      assert.strictEqual(yield* reportAs(sessionRun(turn), "from-own"), "accepted");
      assert.strictEqual((yield* ledger.getTask(turn.taskId))?.task.status, "running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "an approval the notice asks for waits on its request, where a person can answer",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("look: plan the logistics", "a1"), rpcContext);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        const turn = yield* onlyTask;
        const session = turn.worker!.threadId;
        const notice = harness.world.addRun(session, MessageId.make("message:command-notice"));
        noticeRunsOf(harness.world).set(notice.id, sessionRun(turn));
        const noticeNode = NodeId.make("node:notice");
        harness.world.runs.set(
          session,
          (harness.world.runs.get(session) ?? []).map((run) =>
            run.id === notice.id ? { ...run, rootNodeId: noticeNode } : run,
          ),
        );
        harness.world.runtimeRequests.set(session, [
          {
            id: RuntimeRequestId.make("approval:notice"),
            nodeId: noticeNode,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
            resolvedAt: null,
          } as never,
        ]);
        yield* reports.reconcile(runtime.ownerToken);
        const needsYou = (yield* ledger.getTask(turn.taskId))?.task.observed?.needsYou ?? [];
        assert.deepStrictEqual(
          needsYou.map((need) => need.kind),
          ["approval"],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
