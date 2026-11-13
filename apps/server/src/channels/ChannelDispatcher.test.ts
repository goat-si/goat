import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ChannelInputId,
  ChannelQuestionId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { answerForwardIdsFor, taskEventIdFor, turnSteerIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { holdNextLedgerCall, trackPlacements } from "./testkit/dispatchRace.ts";
import { taskWriteMilestones } from "./testkit/channelWriteMilestones.ts";
import { RemoteMachine, remoteScript } from "./testing/RemoteMachine.ts";
import {
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

it.effect("#2193 preserves the newer follow-up fence when the worker run is cancelled", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    yield* gateway.ingest(slackInput("do: inspect the build", "cancel-two-1"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const first = ChannelInputId.make("input:cancel-first");
    const second = ChannelInputId.make("input:cancel-second");
    for (const inputId of [first, second]) {
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.followup.received",
          payload: { inputId, text: "follow-up", from: "Owner", generation: task.generation },
        },
        {
          owner: runtime.ownerToken,
          forward: true,
          pendingAnswerMessageId: turnSteerIdsFor(inputId, "first").messageId,
        },
      );
    }
    const [older, newer] = yield* ledger.listPendingForwards(10);
    const newerFence = turnSteerIdsFor(second, "first").messageId;
    assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, newerFence);
    harness.world.setStatus(task.worker!.threadId, 1, "cancelled");
    yield* dispatcher.forward(older!, runtime.ownerToken);
    assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, newerFence);
    assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
    yield* dispatcher.forward(newer!, runtime.ownerToken);
    assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
    assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    assert.lengthOf(harness.world.sends, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "#2193 preserves the newer non-session follow-up fence when the earlier one is refused",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* gateway.ingest(slackInput("do: inspect the build", "two-worker-1"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const firstInput = ChannelInputId.make("input:two-worker-first");
      const secondInput = ChannelInputId.make("input:two-worker-second");
      for (const inputId of [firstInput, secondInput]) {
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.followup.received",
            payload: { inputId, text: "follow-up", from: "Owner", generation: task.generation },
          },
          {
            owner: runtime.ownerToken,
            forward: true,
            pendingAnswerMessageId: turnSteerIdsFor(inputId, "first").messageId,
          },
        );
      }
      const [firstForward, secondForward] = yield* ledger.listPendingForwards(10);
      assert.isDefined(firstForward);
      assert.isDefined(secondForward);
      const secondFence = turnSteerIdsFor(secondInput, "first").messageId;
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, secondFence);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
      yield* dispatcher.forward(firstForward!, runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, secondFence);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      yield* dispatcher.forward(secondForward!, runtime.ownerToken);
      assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each([true, false])(
  "#2193 drops a revoked answer on a cancelled non-session task, owns fence: %s",
  (ownsFence) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* gateway.ingest(slackInput("do: inspect the build", "cancel-worker-1"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const questionId = ChannelQuestionId.make("question:cancel-worker");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.opened",
          payload: { question: { questionId, text: "Which?", askedAt: task.updatedAt } },
        },
        { owner: runtime.ownerToken },
      );
      const answerEventId = taskEventIdFor(
        task.taskId,
        (yield* ledger.getTask(task.taskId))!.task.version + 1,
      );
      const answerFence = answerForwardIdsFor(answerEventId).messageId;
      const fence = ownsFence ? answerFence : "later-answer-fence";
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.answered",
          payload: { questionId, answer: "the big one" },
        },
        {
          owner: runtime.ownerToken,
          forward: true,
          eventId: answerEventId,
          pendingAnswerMessageId: fence,
        },
      );
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.cancelled",
          payload: { reason: "Stopped." },
        },
        { owner: runtime.ownerToken },
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
      const [pending] = yield* ledger.listPendingForwards(10);
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, fence);
      yield* dispatcher.forward(pending!, runtime.ownerToken);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      assert.strictEqual(
        (yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId,
        ownsFence ? undefined : fence,
      );
      assert.strictEqual((yield* onlyTask).status, "cancelled");
      assert.lengthOf((yield* onlyTask).openQuestions, 0);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each([
  ["followup", false],
  ["followup", true],
  ["answer", false],
  ["answer", true],
] as const)("#2193 records a non-session mode refusal atomically %s", ([kind, restored]) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    yield* gateway.ingest(slackInput("do: inspect the build", "mode-refusal-1"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    if (kind === "answer") {
      const questionId = ChannelQuestionId.make("question:mode-refusal");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.opened",
          payload: { question: { questionId, text: "Which?", askedAt: task.updatedAt } },
        },
        { owner: runtime.ownerToken },
      );
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.answered",
          payload: { questionId, answer: "the big one" },
        },
        { owner: runtime.ownerToken, forward: true, pendingAnswerMessageId: "answer-fence" },
      );
    } else {
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.followup.received",
          payload: {
            inputId: ChannelInputId.make("input:mode-refusal"),
            text: "check logs",
            from: "Owner",
            generation: task.generation,
          },
        },
        { owner: runtime.ownerToken, forward: true, pendingAnswerMessageId: "followup-fence" },
      );
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_identities SET runtime_mode_ceiling = 'approval-required' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const send = threads.sendToThread;
    let refuse = true;
    let attempts = 0;
    Object.assign(threads, {
      sendToThread: (input: Parameters<typeof send>[0]) =>
        Effect.gen(function* () {
          attempts += 1;
          if (!refuse) return yield* send(input);
          const limit = yield* DispatchModeLimit;
          if (limit?.refused === undefined)
            return yield* Effect.die("missing mode refusal reference");
          yield* Ref.set<DispatchModeRefusal | undefined>(limit.refused, {
            threadId: input.threadId,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            mode: "runtime",
          });
          return yield* Effect.fail({ _tag: "OrchestratorCommandRejectedError" } as never);
        }),
    });
    const [pending] = yield* ledger.listPendingForwards(10);
    const complete = ledger.completeForward;
    Object.assign(ledger, {
      completeForward: () => Effect.die("crash between question and forward completion"),
    });
    const first = yield* dispatcher.forward(pending!, runtime.ownerToken).pipe(Effect.exit);
    Object.assign(ledger, { completeForward: complete });
    assert.strictEqual(first._tag, "Success");
    assert.lengthOf((yield* onlyTask).openQuestions, 1);
    assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    if (restored) {
      refuse = false;
      yield* sql`UPDATE channel_identities SET runtime_mode_ceiling = 'auto-accept-edits' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
    }
    yield* dispatcher.forward(pending!, runtime.ownerToken);
    assert.lengthOf((yield* onlyTask).openQuestions, 1);
    assert.strictEqual(attempts, 1);
    assert.lengthOf(harness.world.sends, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  ["followup", false],
  ["followup", true],
  ["answer", false],
  ["answer", true],
] as const)("#2193 rechecks non-session authority %s", ([kind, revoked]) => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    yield* gateway.ingest(slackInput("do: inspect the build", "authority-1"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    assert.strictEqual(task.status, "running");
    if (kind === "answer") {
      const questionId = ChannelQuestionId.make("question:authority");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.opened",
          payload: { question: { questionId, text: "Which?", askedAt: task.updatedAt } },
        },
        { owner: runtime.ownerToken },
      );
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.answered",
          payload: { questionId, answer: "the big one" },
        },
        { owner: runtime.ownerToken, forward: true, pendingAnswerMessageId: "answer-fence" },
      );
    } else {
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.followup.received",
          payload: {
            inputId: ChannelInputId.make("input:authority"),
            text: "check logs",
            from: "Owner",
            generation: task.generation,
          },
        },
        { owner: runtime.ownerToken, forward: true, pendingAnswerMessageId: "followup-fence" },
      );
    }
    const threads = yield* ThreadManagement.ThreadManagementService;
    const send = threads.sendToThread;
    const ceilings: Array<string | undefined> = [];
    Object.assign(threads, {
      sendToThread: (input: Parameters<typeof send>[0]) =>
        Effect.flatMap(DispatchModeLimit, (limit) => {
          ceilings.push(limit?.runtimeMode);
          return send(input);
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    if (revoked)
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
    else
      yield* sql`UPDATE channel_identities SET runtime_mode_ceiling = 'approval-required' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
    const [pending] = yield* ledger.listPendingForwards(10);
    yield* dispatcher.forward(pending!, runtime.ownerToken);
    if (revoked) {
      assert.lengthOf(harness.world.sends, 0);
      assert.include((yield* onlyTask).openQuestions[0]!.text, "permission");
    } else {
      assert.deepStrictEqual(ceilings, ["approval-required"]);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "freezes before local launch and reuses the exact brief after interrupted acceptance",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
      );
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(files.notes, "abc");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "local-brief-owner", now, staleBefore: now });
      const input = yield* gateway.ingest(
        goatInput("do: inspect the build", "local-brief"),
        rpcContext,
      );
      yield* reception.receive(input.inputId, "local-brief-owner");
      const task = yield* onlyTask;
      let frozenTaskVersion: number | undefined;
      harness.launch.afterAccepted = (launch) =>
        Effect.gen(function* () {
          const stored = (yield* ledger.getTask(task.taskId))!;
          const brief = yield* ledger.latestTaskBrief(task.taskId);
          assert.strictEqual(stored.task.status, "dispatching");
          assert.strictEqual(stored.task.briefVersion, 1);
          assert.strictEqual(brief?.deliveredText, launch.initialMessage?.text);
          assert.strictEqual(brief?.instruction, task.instruction);
          assert.strictEqual(brief?.intent, "inspect the build");
          assert.isDefined(brief?.context.notesPath);
          assert.strictEqual(
            brief?.context.notesRevision,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          );
          assert.isDefined(brief?.context.skillsPath);
          assert.strictEqual(brief?.target.provider, launch.modelSelection.instanceId);
          assert.strictEqual(brief?.target.model, launch.modelSelection.model);
          frozenTaskVersion = stored.task.version;
          return yield* Effect.die("simulated interruption after launch acceptance");
        }).pipe(Effect.orDie);
      const interrupted = yield* dispatcher
        .dispatch(task.taskId, "local-brief-owner")
        .pipe(Effect.exit);
      assert.strictEqual(interrupted._tag, "Failure");
      const frozen = yield* ledger.latestTaskBrief(task.taskId);
      yield* fs.writeFileString(files.notes, "changed after the first launch");
      harness.launch.afterAccepted = (launch) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.version, frozenTaskVersion);
          assert.deepStrictEqual(yield* ledger.latestTaskBrief(task.taskId), frozen);
          assert.strictEqual(launch.initialMessage?.text, frozen?.deliveredText);
        }).pipe(Effect.orDie);
      yield* dispatcher.dispatch(task.taskId, "local-brief-owner");
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
      assert.lengthOf(harness.world.launches, 2);
      assert.strictEqual(
        harness.world.launches[0]?.commandId,
        harness.world.launches[1]?.commandId,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("uses a ready sibling when the configured instance could not initialize", () => {
  const harness = makeHarness({
    providerInstances: [
      { instanceId: "codex", missing: true },
      { instanceId: "codex-work", weeklyUsedPercent: 20 },
    ],
  });
  return Effect.gen(function* () {
    yield* setupBot;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "missing-provider-owner", now, staleBefore: now });
    const input = yield* gateway.ingest(
      goatInput("do: use the ready account", "missing-instance"),
      rpcContext,
    );
    yield* reception.receive(input.inputId, "missing-provider-owner");
    const task = yield* onlyTask;
    yield* dispatcher.dispatch(task.taskId, "missing-provider-owner");
    assert.strictEqual((yield* onlyTask).status, "running");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex-work");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6.1-sol");
  }).pipe(Effect.provide(harness.layer));
});

const lunaSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
} as const;
const astraSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
} as const;

/** One "do:" task through reception and dispatch; the launch is read from harness.world. */
const dispatchOne = (harness: ReturnType<typeof makeHarness>, key: string) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: key + "-owner", now, staleBefore: now });
    const input = yield* gateway.ingest(goatInput("do: inspect the build", key), rpcContext);
    yield* reception.receive(input.inputId, key + "-owner");
    const task = yield* onlyTask;
    yield* dispatcher.dispatch(task.taskId, key + "-owner");
  });

it.effect(
  "dispatches coding work on the configured GOAT Bot model when nothing else sets one",
  () => {
    const harness = makeHarness({
      shellDefaultModel: null,
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: lunaSelection,
        goatBotModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
      }).pipe(Layer.orDie),
    });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* dispatchOne(harness, "bot-model");
      assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6.1-sol");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a project default still wins over the configured GOAT Bot model", () => {
  const harness = makeHarness({
    shellDefaultModel: astraSelection,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: lunaSelection,
      goatBotModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
    }).pipe(Layer.orDie),
  });
  return Effect.gen(function* () {
    yield* setupBot;
    yield* dispatchOne(harness, "project-wins");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6-astra");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("the server default still wins over the configured GOAT Bot model", () => {
  const harness = makeHarness({
    shellDefaultModel: null,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: lunaSelection,
      defaultModelSelection: astraSelection,
      goatBotModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
    }).pipe(Layer.orDie),
  });
  return Effect.gen(function* () {
    yield* setupBot;
    yield* dispatchOne(harness, "server-wins");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6-astra");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "a configured GOAT Bot model this machine does not offer falls back to the text generation model",
  () => {
    const harness = makeHarness({
      shellDefaultModel: null,
      providerInstances: [{ instanceId: "codex", models: ["gpt-6-luna"] }],
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: lunaSelection,
        goatBotModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: "codex", config: {}, enabled: true },
        },
      }).pipe(Layer.orDie),
    });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* dispatchOne(harness, "bot-not-offered");
      assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6-luna");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps the text generation model when nothing is configured anywhere", () => {
  const harness = makeHarness({
    shellDefaultModel: null,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: lunaSelection,
      defaultRuntimeMode: "full-access",
    }).pipe(Layer.orDie),
  });
  return Effect.gen(function* () {
    yield* setupBot;
    yield* dispatchOne(harness, "nothing-configured");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6-luna");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stopping a workstream stops its launched thread child and settles its record", () => {
  const harness = makeHarness();
  harness.script.current = (input) =>
    input.mode === "input" && input.inputText === "stop"
      ? Effect.succeed({ replyText: "Stopping.", action: { type: "stop_work" as const } })
      : defaultScript(input);
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const childWork = yield* ChannelChildWork.ChannelChildWork;
    const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
    yield* gateway.ingest(goatInput("do: fix the build", "stop-children"), rpcContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const admission = yield* childWork.admit({
      callerThreadId: task.worker!.threadId,
      surface: "thread_launch",
      prompt: "watch the deploy",
      destinationKey: "codex/gpt-6.1-sol",
    });
    if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
    // The launched child thread is live in the world, so its stop is a real interrupt.
    const childThreadId = ThreadId.make("thread:child-of-worker");
    harness.world.addRun(childThreadId, MessageId.make("child-msg"));
    yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThreadId }));
    yield* gateway.ingest(goatInput("stop", "stop-children-2"), rpcContext);
    yield* runtime.drain;
    yield* runtime.drain;
    assert.include(harness.world.interrupts, task.worker!.threadId);
    assert.include(harness.world.interrupts, childThreadId);
    assert.strictEqual(harness.world.latestRun(childThreadId)?.status, "cancelled");
    const record = yield* store.get(task.taskId, admission.record.childWorkId);
    assert.strictEqual(record?.state, "cancelled");
    assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a stop whose worker thread vanished still stops its recorded thread children", () => {
  const harness = makeHarness();
  harness.script.current = (input) =>
    input.mode === "input" && input.inputText === "stop"
      ? Effect.succeed({ replyText: "Stopping.", action: { type: "stop_work" as const } })
      : defaultScript(input);
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const childWork = yield* ChannelChildWork.ChannelChildWork;
    const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
    yield* gateway.ingest(goatInput("do: fix the build", "stop-missing-worker"), rpcContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const admission = yield* childWork.admit({
      callerThreadId: task.worker!.threadId,
      surface: "thread_launch",
      prompt: "watch the deploy",
      destinationKey: "codex/gpt-6.1-sol",
    });
    if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
    const childThreadId = ThreadId.make("thread:child-of-missing-worker");
    harness.world.addRun(childThreadId, MessageId.make("child-msg"));
    yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThreadId }));
    // The worker thread is deleted before the stop lands: its reads fail as missing.
    harness.world.runs.delete(task.worker!.threadId);
    yield* gateway.ingest(goatInput("stop", "stop-missing-worker-2"), rpcContext);
    yield* runtime.drain;
    yield* runtime.drain;
    // Inside the launch grace the stop stays pending without touching the children.
    assert.notInclude(harness.world.interrupts, childThreadId);
    yield* TestClock.adjust(Duration.minutes(3));
    yield* runtime.drain;
    yield* runtime.drain;
    assert.include(harness.world.interrupts, childThreadId);
    const record = yield* store.get(task.taskId, admission.record.childWorkId);
    assert.strictEqual(record?.state, "cancelled");
    assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
  }).pipe(Effect.provide(harness.layer));
});

const placementHarness = () => {
  const machine = new RemoteMachine();
  machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
  machine.hostQuotas = { codex: 20 };
  const harness = makeHarness({
    sshRemote: machine.layer,
    projects: 1,
    repositoryIdentity: {
      canonicalKey: "github.com/goat-si/goat",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/goat-si/goat.git",
      },
    },
    settingsLayer: ServerSettings.layerTest({
      channelAutoPlacement: true,
      textGenerationModelSelection: modelSelection,
    }).pipe(Layer.orDie),
    providerInstances: [{ instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 }],
  });
  harness.script.current = remoteScript;
  return { machine, harness };
};

/** A Slack request received for automatic placement, owned by "placement-owner". */
const receivedForPlacement = (key: string) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* (yield* ChannelLedger.ChannelLedger).claimOwnership({
      token: "placement-owner",
      now,
      staleBefore: now,
    });
    const gateway = yield* ChannelGateway.ChannelGateway;
    const input = yield* gateway.ingest(slackInput("do: inspect the build", key), slackContext);
    yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
      input.inputId,
      "placement-owner",
    );
    return yield* onlyTask;
  });

/**
 * Parks the task's automatic placement while it lists the remote projects, before it claims, and
 * holds a second dispatch after it read the task and before it checks for that placement.
 */
const secondDispatchBehindPlacement = (machine: RemoteMachine, key: string) =>
  Effect.gen(function* () {
    const task = yield* receivedForPlacement(key);
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const listing = yield* Deferred.make<void>();
    const listed = yield* Deferred.make<void>();
    machine.onProjectList = Effect.suspend(() => {
      machine.onProjectList = Effect.void;
      return Deferred.succeed(listing, undefined).pipe(Effect.andThen(Deferred.await(listed)));
    });
    const placements = trackPlacements();
    yield* placements.observe(dispatcher.dispatch(task.taskId, "placement-owner"));
    yield* Deferred.await(listing);
    const identity = yield* holdNextLedgerCall("findIdentity");
    const second = yield* Effect.forkChild(dispatcher.dispatch(task.taskId, "placement-owner"));
    yield* identity.reached;
    return {
      second,
      /** The placement finishes: it claims or fails the task, and its fiber has ended. */
      placementEnds: Deferred.succeed(listed, undefined).pipe(Effect.andThen(placements.settled)),
      release: identity.release,
    };
  });

const succeeded = (exit: Exit.Exit<void, ChannelLedger.ChannelLedgerError>) =>
  assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");

const failedEvents = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) =>
      sql<{
        readonly reason: string;
      }>`SELECT json_extract(event_json, '$.payload.reason') AS reason FROM channel_task_events WHERE type = 'task.failed'`,
  ),
  Effect.map((rows) => rows.map((row) => row.reason)),
);

it.effect(
  "regression #3159: a dispatch that read the task before its automatic placement claimed it leaves the claimed work running",
  () => {
    const { machine, harness } = placementHarness();
    return Effect.gen(function* () {
      const writes = yield* taskWriteMilestones();
      const race = yield* secondDispatchBehindPlacement(machine, "placement-race-claimed");
      yield* race.placementEnds;
      // The remote launch runs in its own fiber: wait until it recorded its attempt and bound.
      yield* writes.waitFor(
        (task, state) => task.status === "running" && (state?.attempts ?? 0) > 0,
      );
      yield* race.release;
      succeeded(yield* Fiber.await(race.second));
      assert.strictEqual((yield* onlyTask).status, "running");
      assert.deepStrictEqual(yield* failedEvents, []);
      assert.lengthOf(machine.launches, 1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);

it.effect(
  "regression #3159: a dispatch that read the task before its placement failed a revoked requester leaves that one failure",
  () => {
    const { machine, harness } = placementHarness();
    return Effect.gen(function* () {
      const race = yield* secondDispatchBehindPlacement(machine, "placement-race-revoked");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
      yield* race.placementEnds;
      yield* race.release;
      succeeded(yield* Fiber.await(race.second));
      assert.strictEqual((yield* onlyTask).status, "failed");
      assert.deepStrictEqual(yield* failedEvents, ["permission_changed"]);
      assert.lengthOf(machine.launches, 0);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);

it.effect(
  "regression #3159: a launch-uncertain failure that another writer beats leaves the task to the next pass",
  () => {
    const { machine, harness } = placementHarness();
    machine.loseNextLaunchAnswer = true;
    return Effect.gen(function* () {
      const task = yield* receivedForPlacement("placement-race-uncertain");
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const placements = trackPlacements();
      yield* placements.observe(dispatcher.dispatch(task.taskId, "placement-owner"));
      yield* placements.settled;
      // The launch fiber records the attempt before the host call and, once the answer is lost,
      // ends reading only the task (ChannelRemoteWorkers launchOnce), so the hold below is ours.
      yield* Deferred.await(machine.launchAnswerLost);
      assert.strictEqual((yield* onlyTask).status, "dispatching");
      // The recorded attempt now names another machine than the claim: attempted elsewhere.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.host', 'other-box') WHERE key = ${"remote-worker:" + task.taskId}`;
      assert.include(yield* ledger.getRemoteWorker(task.taskId), '"host":"other-box"');
      const state = yield* holdNextLedgerCall("getRemoteWorker");
      const third = yield* Effect.forkChild(dispatcher.dispatch(task.taskId, "placement-owner"));
      yield* state.reached;
      // The requester stops the task between that dispatch's read and its failure write.
      const moved = yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        { type: "task.cancelled", payload: { reason: "Stopped by Owner." } },
        { owner: "placement-owner" },
      );
      assert.isDefined(moved);
      yield* state.release;
      succeeded(yield* Fiber.await(third));
      assert.strictEqual((yield* onlyTask).status, "cancelled");
      assert.deepStrictEqual(yield* failedEvents, []);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);
