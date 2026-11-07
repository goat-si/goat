import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput } from "@goat/contracts";
import {
  ChannelChildWorkId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as ChildStore from "./channelChildWorkStore.ts";
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
import { launchWatchesOf } from "./testkit/launchWakesFake.ts";

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
          action: { type: "run_turn" as const, title: "Probe", instruction: "probe" },
        })
      : defaultScript(input);
  return harness;
};

const child = ThreadId.make("thread:launched-probe");
const childRun = "run:" + child + ":1";

/** A bot turn that launched a coding thread, which then ended; the launch watch follows it. */
const launchedAndEnded = (
  harness: ReturnType<typeof harnessFor>,
  watch: { readonly detached: boolean } | null = { detached: false },
) =>
  Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const childWork = yield* ChannelChildWork.ChannelChildWork;
    yield* gateway.ingest(goatInput("look: start the probe", "l1"), rpcContext);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    const turn = yield* onlyTask;
    const session = turn.worker!.threadId;
    const admission = yield* childWork.admit({
      callerThreadId: session,
      callerRunId: turn.worker!.runId,
      surface: "thread_launch",
      prompt: "run the probe in a worktree",
      destinationKey: "codex/gpt-6.1-sol",
    });
    if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
    harness.world.addRun(child, MessageId.make("msg:launched-probe"));
    yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: child }));
    yield* childWork.markBound(admission.record, { threadId: child });
    if (watch !== null)
      launchWatchesOf(harness.world).set(child, { ...watch, skippedRuns: [], reportedEnds: {} });
    harness.world.setStatus(session, 1, "completed", "Started the probe. Open the task.");
    harness.world.setStatus(child, 1, "completed", "todo list fixture complete");
    // The launched thread ended at the start of time, so a TestClock adjust can age it.
    harness.world.runs.set(
      child,
      (harness.world.runs.get(child) ?? []).map((run) => ({
        ...run,
        completedAt: DateTime.makeUnsafe(0),
      })),
    );
    yield* reports.reconcile(runtime.ownerToken);
    yield* runtime.drain;
    return { runtime, reports, session, taskId: turn.taskId };
  });

const wake = (session: string) =>
  MessageId.make(
    "message:launch-watch:" +
      [session, "", child].map(encodeURIComponent).join(":") +
      ":run:" +
      childRun,
  );

const texts = Effect.map(botMessages, (records) => records.messages.map((message) => message.text));

describe("a coding thread a GOAT Bot turn launched reports its result back", () => {
  it.effect(
    "delivers the wake run's answer as the turn's result, once, and never the launching run's",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const { runtime, reports, session, taskId } = yield* launchedAndEnded(harness);
        // The thread ended but its wake has not run on the session yet: the turn waits for it.
        const owed = yield* ledger.getTask(taskId);
        assert.strictEqual(owed?.task.status, "running");
        assert.strictEqual(owed?.completionHold, "background");

        harness.world.addRun(session, wake(session));
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "running");

        harness.world.setStatus(
          session,
          2,
          "completed",
          "The probe finished: todo list fixture complete.",
        );
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "completed");
        const delivered = yield* texts;
        assert.strictEqual(
          delivered.filter((text) => text.startsWith("The probe finished")).length,
          1,
        );
        assert.isFalse(delivered.some((text) => text.startsWith("Started the probe")));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("settles at once when no wake is coming because the thread was unwatched", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const { taskId } = yield* launchedAndEnded(harness, { detached: true });
      assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "completed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells the person once when the result has not come back, and keeps waiting", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const { runtime, reports, taskId } = yield* launchedAndEnded(harness);
      yield* TestClock.adjust("21 minutes");
      for (let pass = 0; pass < 2; pass += 1) {
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
      }
      assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "running");
      const notices = (yield* texts).filter((text) => text.includes("has made no progress"));
      assert.strictEqual(notices.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails the turn when the wake run fails", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const { runtime, reports, session, taskId } = yield* launchedAndEnded(harness);
      harness.world.addRun(session, wake(session));
      harness.world.setStatus(session, 2, "failed");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "failed");
    }).pipe(Effect.provide(harness.layer));
  });
});
describe("the launched thread's wake and its watch", () => {
  it.effect("delivers a wake that was sent before the thread was unwatched", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const { runtime, reports, session, taskId } = yield* launchedAndEnded(harness);
      harness.world.addRun(session, wake(session));
      launchWatchesOf(harness.world).delete(child);
      harness.world.setStatus(session, 2, "completed", "The probe finished.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "completed");
      assert.include(yield* texts, "The probe finished.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps waiting on a wake it cannot place on the task, watched or not", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const store = yield* ChildStore.ChannelChildWorkStore;
      const { runtime, reports, session, taskId } = yield* launchedAndEnded(harness);
      const [first] = (yield* store.listForTask(taskId)).filter(
        (record) => record.surface === "thread_launch",
      );
      // A second launch recorded for the same thread from another run: the wake names neither.
      yield* store.admitReserved(
        {
          ...first!,
          childWorkId: ChannelChildWorkId.make("probe-twin"),
          requestKey: "probe-twin",
          callerRunId: RunId.make("run:elsewhere"),
        },
        100,
      );
      harness.world.addRun(session, wake(session));
      harness.world.setStatus(session, 2, "completed", "The probe finished.");
      launchWatchesOf(harness.world).delete(child);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.getTask(taskId))?.task.status, "running");
      assert.notInclude(yield* texts, "Started the probe. Open the task.");
    }).pipe(Effect.provide(harness.layer));
  });
});
