import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput } from "@goat/contracts";
import { ProjectId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { GOAT_BOT_DISPATCH_RULE, GOAT_BOT_READ_ONLY_RULE } from "./ChannelDispatcher.ts";
import { turnSteerIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" } as const;

/** "look:" asks GOAT Bot to take a turn itself; everything else follows the default script. */
const turnScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  if (input.mode === "input" && text.startsWith("also:")) {
    const running = input.tasks.find((task) => task.status === "running");
    return Effect.succeed({
      replyText: "Passing that on.",
      action: { type: "follow_up" as const, taskId: running?.taskId ?? ("task:none" as never) },
    });
  }
  if (input.mode === "input" && text.startsWith("look:")) {
    return Effect.succeed({
      replyText: "On it.",
      action: {
        type: "run_turn" as const,
        title: "Look into it",
        instruction: text.slice(5).trim(),
      },
    });
  }
  return defaultScript(input);
};

const harnessWith = (
  goatBotModelSelection: typeof botModel | null,
  defaultRuntimeMode: "full-access" | "approval-required" = "full-access",
) => {
  const harness = makeHarness({
    botWorkspace: true,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode,
      goatBotModelSelection,
    }).pipe(Layer.orDie),
  });
  harness.script.current = turnScript;
  return harness;
};

/** Starts one turn and lets its worker report in, so the turn is running. */
const runningTurn = Effect.gen(function* () {
  yield* setupBot;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  yield* gateway.ingest(goatInput("look: why is the disk full?", "s1"), rpcContext);
  yield* runtime.drain;
  yield* reports.reconcile(runtime.ownerToken);
  const turn = yield* onlyTask;
  assert.strictEqual(turn.status, "running");
  return { gateway, runtime, reports, turn };
});

describe("GOAT Bot turns", () => {
  it.effect(
    "acknowledges first, then runs in its own workspace on its model with full access",
    () => {
      // The new-thread default is for people's threads; it does not narrow the bot.
      const harness = harnessWith(botModel, "approval-required");
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* gateway.ingest(goatInput("look: why is the disk full?", "t1"), rpcContext);
        yield* runtime.drain;

        const task = yield* onlyTask;
        assert.strictEqual(task.kind, "turn");
        const launch = harness.world.launches[0]!;
        assert.strictEqual(launch.projectId, scratchProjectId);
        assert.deepStrictEqual(launch.modelSelection, botModel);
        assert.strictEqual(launch.runtimeMode, "full-access");
        assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });
        assert.include(launch.initialMessage?.text ?? "", "You are GOAT Bot handling this message");
        // Read-only is the prompt's promise now that the sandbox allows everything.
        assert.include(launch.initialMessage?.text ?? "", GOAT_BOT_READ_ONLY_RULE);
        assert.include(launch.initialMessage?.text ?? "", "delegate_task");
        assert.include(launch.initialMessage?.text ?? "", GOAT_BOT_DISPATCH_RULE);
        // The acknowledgement was committed with the input, before the turn could run.
        const texts = (yield* botMessages).messages.map((message) => message.text);
        assert.include(texts, "On it.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("never runs a turn above what a linked Slack person may do", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("look: why is the disk full?", "Ev1"), {
        ...slackContext,
        runtimeModeCeiling: "full-access",
      });
      yield* runtime.drain;
      const launch = harness.world.launches[0]!;
      assert.strictEqual((yield* onlyTask).kind, "turn");
      // The link was made at auto-accept-edits.
      assert.strictEqual(launch.runtimeMode, "auto-accept-edits");
      assert.include(launch.initialMessage?.text ?? "", GOAT_BOT_READ_ONLY_RULE);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("follows the new-thread default when no bot model is chosen", () => {
    const harness = harnessWith(null);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("look: what changed today?", "t2"), rpcContext);
      yield* runtime.drain;
      const chosen = harness.world.launches[0]!.modelSelection;
      assert.strictEqual(chosen.instanceId, modelSelection.instanceId);
      assert.strictEqual(chosen.model, modelSelection.model);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("delivers the turn's own answer as written", () => {
    const harness = harnessWith(botModel);
    const reworded: Array<string> = [];
    harness.script.current = (input) => {
      if (input.mode === "task_event") reworded.push(input.taskEvent?.summary ?? "");
      return turnScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("look: why is the disk full?", "t3"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      harness.world.setStatus(
        task.worker!.threadId,
        1,
        "completed",
        "Docker images take 41 GB; prune them to free it.",
      );
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.isTrue(texts.some((text) => text.startsWith("Docker images take 41 GB")));
      assert.isFalse(texts.some((text) => text.startsWith("Done: Look into it")));
      assert.deepStrictEqual(reworded, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records a follow-up with its reply, then steers the running run once", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { gateway, runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const followUp = goatInput("also: check /var/log too", "s2");
      yield* gateway.ingest(followUp, rpcContext);
      yield* gateway.ingest(followUp, rpcContext);
      // Reception only: the follow-up is recorded with its reply before anything is sent.
      const pending = yield* ledger.listPendingForwards(10);
      assert.lengthOf(pending, 0);
      yield* runtime.drain;

      const page = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.lengthOf(page.tasks, 1);
      const sends = harness.world.sends.filter((send) => send.text.includes("/var/log"));
      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]!.threadId, turn.worker!.threadId);
      assert.strictEqual(sends[0]!.mode, "auto");
      // It joined the running run: no second run on the thread.
      assert.lengthOf(harness.world.runs.get(turn.worker!.threadId)!, 1);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.include(texts, "Passing that on.");
      // The message id comes from the input, so a resend after a restart lands on the same message.
      const entry = (yield* ledger.readConversationTail(turn.conversationId, 5)).find(
        (candidate) => candidate.text === "also: check /var/log too",
      );
      const ids = turnSteerIdsFor(entry!.inputId);
      assert.strictEqual(sends[0]!.messageId, ids.messageId);
      assert.strictEqual(harness.world.steered.get(ids.messageId), turn.worker!.runId);
      assert.isUndefined((yield* ledger.getTask(turn.taskId))!.pendingAnswerMessageId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("replays a follow-up recorded before a crash, sending it once", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { gateway, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("also: and the swap file", "c1"), rpcContext);
      // Reception commits; the process "dies" before the forward loop runs.
      const [input] = yield* ledger.listPendingInputs(10);
      yield* reception.receive(input!, runtime.ownerToken);
      const [pending] = yield* ledger.listPendingForwards(10);
      assert.strictEqual(pending!.event.type, "task.followup.received");
      // The send went out but the process died before recording it; recovery sends it again.
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      const sends = harness.world.sends.filter((send) => send.text.includes("swap file"));
      assert.lengthOf(sends, 2);
      assert.strictEqual(sends[0]!.messageId, sends[1]!.messageId);
      assert.lengthOf(harness.world.runs.get(turn.worker!.threadId)!, 1);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the task open when the run ends just before the follow-up is sent", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { gateway, reports, runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const threadId = turn.worker!.threadId;
      yield* gateway.ingest(goatInput("also: and /tmp", "f1"), rpcContext);
      const [input] = yield* ledger.listPendingInputs(10);
      yield* reception.receive(input!, runtime.ownerToken);
      // The first run finishes before the follow-up reaches it.
      harness.world.setStatus(threadId, 1, "completed", "Docker images take 41 GB.");
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "running");

      const [pending] = yield* ledger.listPendingForwards(10);
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      // It started the worker's next run, and the task now waits on that run.
      const runs = harness.world.runs.get(threadId)!;
      assert.lengthOf(runs, 2);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.worker!.runId, runs[1]!.id);
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "running");

      harness.world.setStatus(threadId, 2, "completed", "Docker takes 41 GB and /tmp 3 GB.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const done = (yield* ledger.getTask(turn.taskId))!.task;
      assert.strictEqual(done.status, "completed");
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.include(texts, "Docker takes 41 GB and /tmp 3 GB.");
      assert.notInclude(texts, "Docker images take 41 GB.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not pass on a follow-up to work that is not running", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("also: anything else", "z1"), rpcContext);
      yield* runtime.drain;
      assert.lengthOf(harness.world.sends, 0);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.isTrue(texts.some((text) => text.startsWith("That work isn't running anymore")));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("starts a new turn when the earlier one has finished", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("look: first question", "n1"), rpcContext);
      yield* runtime.drain;
      const first = yield* onlyTask;
      harness.world.setStatus(first.worker!.threadId, 1, "completed", "First answer.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("look: second question", "n2"), rpcContext);
      yield* runtime.drain;
      const page = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.lengthOf(page.tasks, 2);
      assert.lengthOf(
        harness.world.sends.filter((send) => send.mode === "steer"),
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

const followUpInput = (pending: ChannelLedger.ChannelPendingEvent) => {
  if (pending.event.type !== "task.followup.received") throw new Error("not a follow-up");
  return pending.event.payload.inputId;
};

describe("GOAT Bot follow-ups under failure", () => {
  /** Records follow-ups through reception only, as if the forward loop has not run yet. */
  const record = (texts: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      for (const [index, text] of texts.entries()) {
        yield* gateway.ingest(goatInput(text, "rec-" + index + "-" + text), rpcContext);
        const [input] = yield* ledger.listPendingInputs(10);
        yield* reception.receive(input!, runtime.ownerToken);
      }
      return yield* ledger.listPendingForwards(10);
    });

  it.effect("never lets a later follow-up overtake one still waiting, nor the task settle", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { reports, runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const threadId = turn.worker!.threadId;
      const [first, second] = yield* record(["also: first addition", "also: second addition"]);
      assert.strictEqual(first!.event.type, "task.followup.received");
      const firstInput = followUpInput(first!);
      const firstIds = turnSteerIdsFor(firstInput);
      // The first send fails without a definite answer (a dropped connection, say).
      harness.world.sendFailures.set(firstIds.messageId, new Error("connection reset"));

      yield* dispatcher.forward(second!, runtime.ownerToken);
      assert.lengthOf(harness.world.sends, 0);
      yield* dispatcher.forward(first!, runtime.ownerToken);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 2);

      // The run ends meanwhile; neither follow-up has reached it, so the task stays open.
      harness.world.setStatus(threadId, 1, "completed", "Old answer.");
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "running");

      harness.world.sendFailures.clear();
      yield* dispatcher.forward(second!, runtime.ownerToken);
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("second")));
      yield* dispatcher.forward(first!, runtime.ownerToken);
      // The first lands as the next run; the second's fence still holds the task.
      assert.isDefined((yield* ledger.getTask(turn.taskId))!.pendingAnswerMessageId);
      yield* dispatcher.forward(second!, runtime.ownerToken);
      const order = harness.world.sends
        .filter((send) => send.text.includes("addition"))
        .map((send) => (send.text.includes("first") ? "first" : "second"));
      assert.deepStrictEqual(order, ["first", "first", "second"]);
      const task = yield* ledger.getTask(turn.taskId);
      assert.isUndefined(task!.pendingAnswerMessageId);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tries once more, queued under new ids, after a definite rejection", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const [pending] = yield* record(["also: one more thing"]);
      const inputId = followUpInput(pending!);
      harness.world.sendFailures.set(turnSteerIdsFor(inputId).messageId, {
        _tag: "OrchestratorCommandRejectedError",
      });
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      const queued = harness.world.sends.find((send) => send.mode === "queue");
      assert.strictEqual(queued?.messageId, turnSteerIdsFor(inputId, "queued").messageId);
      const task = (yield* ledger.getTask(turn.taskId))!;
      const queuedRun = harness.world.runs
        .get(turn.worker!.threadId)!
        .find((run) => run.userMessageId === queued!.messageId);
      assert.strictEqual(task.task.worker!.runId, queuedRun!.id);
      assert.isUndefined(task.pendingAnswerMessageId);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("starts the asked-for turn when the one it would join ends while reading", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { gateway, reports, runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      let ended = false;
      harness.script.current = (input) => {
        if ((input.inputText ?? "").startsWith("look: and the swap") && !ended) {
          ended = true;
          // The running turn finishes while this message is being read.
          harness.world.setStatus(turn.worker!.threadId, 1, "completed", "Done looking.");
          return reports
            .reconcile(runtime.ownerToken)
            .pipe(Effect.orDie, Effect.andThen(turnScript(input)));
        }
        return turnScript(input);
      };
      yield* gateway.ingest(goatInput("look: and the swap file?", "j1"), rpcContext);
      yield* runtime.drain;
      yield* runtime.drain;
      const page = yield* ledger.listTasks({ ownerId, limit: 10 });
      assert.lengthOf(page.tasks, 2);
      assert.isTrue(page.tasks.some((task) => task.instruction.includes("swap file")));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a follow-up whose work was stopped before it was sent", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const [pending] = yield* record(["also: keep going"]);
      const stored = (yield* ledger.getTask(turn.taskId))!;
      yield* commitTransition(
        ledger,
        stored,
        { type: "task.cancelled", payload: { reason: "Stopped by the person." } },
        { owner: runtime.ownerToken },
      );
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("keep going")));
      assert.lengthOf(harness.world.runs.get(turn.worker!.threadId)!, 1);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks about each follow-up the worker refused, one after another", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const forwards = yield* record(["also: first refused", "also: second refused"]);
      const rejection = { _tag: "OrchestratorCommandRejectedError" };
      for (const pending of forwards) {
        const inputId = followUpInput(pending);
        harness.world.sendFailures.set(turnSteerIdsFor(inputId).messageId, rejection);
        harness.world.sendFailures.set(turnSteerIdsFor(inputId, "queued").messageId, rejection);
      }
      for (const pending of forwards) yield* dispatcher.forward(pending, runtime.ownerToken);
      const task = (yield* ledger.getTask(turn.taskId))!.task;
      assert.strictEqual(task.status, "waiting_input");
      assert.lengthOf(task.openQuestions, 2);
      assert.include(task.openQuestions[0]!.text, "first refused");
      assert.include(task.openQuestions[1]!.text, "second refused");
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not restart a worker a person stopped after a follow-up was recorded", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { reports, runtime, turn } = yield* runningTurn;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const threadId = turn.worker!.threadId;
      const [pending] = yield* record(["also: keep digging"]);
      // The person stops the run in GOAT before the follow-up is sent.
      harness.world.setStatus(threadId, 1, "cancelled");
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "running");
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("keep digging")));
      assert.lengthOf(harness.world.runs.get(threadId)!, 1);
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "binds the same run when the send was accepted but the process died before binding",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { reports, runtime, turn } = yield* runningTurn;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = turn.worker!.threadId;
        const [pending] = yield* record(["also: and the cache"]);
        const ids = turnSteerIdsFor(followUpInput(pending!));
        harness.world.setStatus(threadId, 1, "completed", "First answer.");
        // The earlier process sent it (starting the next run) and died before binding.
        yield* threads.sendToThread({
          projectId: ProjectId.make(turn.target!.projectId),
          commandId: ids.commandId,
          threadId,
          messageId: ids.messageId,
          text: "Follow-up from Owner: also: and the cache",
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        });
        // Reconciliation in between binds the run the follow-up started and lifts its fence.
        yield* reports.reconcile(runtime.ownerToken);
        yield* dispatcher.forward(pending!, runtime.ownerToken);
        const runs = harness.world.runs.get(threadId)!;
        assert.lengthOf(runs, 2);
        const task = (yield* ledger.getTask(turn.taskId))!;
        assert.strictEqual(task.task.worker!.runId, runs[1]!.id);
        assert.isUndefined(task.pendingAnswerMessageId);
        assert.strictEqual(task.task.status, "running");
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
