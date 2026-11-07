import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput } from "@goat/contracts";
import { MessageId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
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
    input.mode === "input" && (input.inputText ?? "").startsWith("look:")
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
      const own = turn.worker!.runId;
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
      noticeRunsOf(harness.world).set(notice.id, turn.worker!.runId);
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
