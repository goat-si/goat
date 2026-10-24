import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import { MessageId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

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
    yield* childWork.markLaunched(admission.record, { threadId: childThreadId });
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
    yield* childWork.markLaunched(admission.record, { threadId: childThreadId });
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
