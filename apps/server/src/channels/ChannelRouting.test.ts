/**
 * The grok-bot routing contract at the channel level: direct answers launch nothing, a busy
 * conversation joins its running turn instead of starting a parallel one, coding work runs in a
 * worktree worker, and no worker starts before the acknowledgement's delivery settles.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the worktree case needs a real git directory on disk.
import { afterEach, assert, describe, it } from "@effect/vitest";
import { type ChannelReceptionInput, ChannelGatewayError } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  ownerId,
  projectId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/** Temp work roots this file makes; each test cleans up its own. */
const tempRoots: Array<string> = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/**
 * "look:" asks GOAT Bot to take a turn itself, "do:" is coding work; anything else plays a
 * question the bot answers directly.
 */
const routingScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
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

const harnessWith = (options: { readonly workspaceRoot?: string } = {}) => {
  const harness = makeHarness({
    botWorkspace: true,
    ...options,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
      goatBotModelSelection: modelSelection,
      goatclaw: { enabled: false },
    }).pipe(Layer.orDie),
  });
  harness.script.current = routingScript;
  return harness;
};

describe("GOAT Bot routing", () => {
  it.effect("answers a direct question without starting work", () => {
    const harness = harnessWith();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("what time is it in Seoul?", "direct-1"), rpcContext);
      yield* runtime.drain;

      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.include(texts, "Okay.");
      assert.lengthOf(harness.world.launches, 0);
      assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers an unrelated message immediately while a turn is running", () => {
    const harness = harnessWith();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("look: why is the disk full?", "turn-1"), rpcContext);
      yield* runtime.drain;
      const turn = yield* onlyTask;
      assert.strictEqual(turn.status, "running");

      yield* gateway.ingest(goatInput("is the deploy done?", "direct-2"), rpcContext);
      yield* runtime.drain;

      // The question got its own answer; nothing was forwarded into the running turn.
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.include(texts, "Okay.");
      assert.lengthOf(harness.world.sends, 0);
      assert.lengthOf(harness.world.launches, 1);
      assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("joins a second investigation to the running turn instead of a parallel one", () => {
    const harness = harnessWith();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("look: why is the disk full?", "turn-1"), rpcContext);
      yield* runtime.drain;
      const turn = yield* onlyTask;
      assert.strictEqual(turn.status, "running");

      yield* gateway.ingest(goatInput("look: and why is the fan loud?", "turn-2"), rpcContext);
      yield* runtime.drain;

      // One workstream: no second turn, no second launch; the request went into the running one.
      assert.lengthOf(harness.world.launches, 1);
      assert.lengthOf((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks, 1);
      const sends = harness.world.sends.filter((send) => send.text.includes("fan loud"));
      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]!.threadId, turn.worker!.threadId);
      assert.strictEqual(sends[0]!.mode, "auto");
      const entry = (yield* ledger.readConversationTail(turn.conversationId, 5)).find((candidate) =>
        candidate.text.includes("fan loud"),
      );
      assert.isDefined(entry);
      // Both messages were acknowledged as they arrived.
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.strictEqual(texts.filter((text) => text === "On it.").length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("dispatches a coding request to a worker thread in its own worktree", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-routing-"));
    tempRoots.push(root);
    NodeFS.mkdirSync(NodePath.join(root, ".git"));
    const harness = harnessWith({ workspaceRoot: root });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const receipt = yield* gateway.ingest(
        goatInput("do: fix the flaky test", "code-1"),
        rpcContext,
      );
      yield* runtime.drain;

      const launch = harness.world.launches[0]!;
      assert.strictEqual(launch.projectId, projectId);
      // Each task in a repository gets its own worktree so two tasks never share a checkout.
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "worktree", baseRef: "HEAD" });
      assert.deepStrictEqual(launch.modelSelection, modelSelection);
      const task = yield* onlyTask;
      assert.isUndefined(task.kind);
      assert.strictEqual(task.originInputId, receipt.inputId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("starts no worker until the acknowledgement's delivery settles", () => {
    const harness = harnessWith();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      // The link notice goes out first; settle it so the failure below hits the acknowledgement.
      yield* runtime.drain;
      harness.slackSent.length = 0;
      harness.slackFailures.push(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "not_sent",
          deliveryErrorCode: "rate_limited",
          retryAfterSeconds: 1,
        }),
      );
      yield* gateway.ingest(
        slackInput("do: fix the flaky test", "Ev30", "1760000000.000030"),
        slackContext,
      );
      yield* runtime.drain;

      // The acknowledgement certainly did not arrive yet, so the work has not started.
      assert.lengthOf(harness.slackSent, 0);
      assert.lengthOf(harness.world.launches, 0);
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "received");

      // Once the retried acknowledgement lands, the worker starts.
      yield* TestClock.adjust(Duration.seconds(2));
      yield* runtime.drain;
      assert.lengthOf(harness.slackSent, 1);
      assert.lengthOf(harness.world.launches, 1);
      assert.notStrictEqual((yield* ledger.getTask(waiting.taskId))!.task.status, "received");
    }).pipe(Effect.provide(harness.layer));
  });
});
