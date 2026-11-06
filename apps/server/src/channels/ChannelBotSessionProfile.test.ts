// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { BotId, type ChannelReceptionInput } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { taskIdFor } from "./channelIds.ts";
import { ask, botModel, current, sessionHarness, settle } from "./ChannelBotSession.testkit.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const main = BotId.make("main");
const rename = (fields: { readonly name?: string; readonly purpose?: string }) =>
  ChannelBotProfiles.ChannelBotProfiles.pipe(
    Effect.flatMap((profiles) => profiles.update({ botId: main, ...fields }, owner)),
  );
const sessionState = (threadId: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly state: string }>`
        SELECT state FROM channel_bot_sessions WHERE thread_id = ${threadId}`,
    ),
    Effect.map((rows) => rows[0]?.state),
  );
const launchedText = (harness: ReturnType<typeof sessionHarness>, index: number) =>
  harness.world.launches[index]?.initialMessage?.text ?? "";

describe("GOAT Bot sessions and the bot's profile", () => {
  it.effect("a rename starts the next idle request in a new session that knows the name", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "p1");
      const thread = first.worker!.threadId;
      assert.isTrue(launchedText(harness, 0).startsWith("## Standing instructions\n"));
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      yield* rename({ name: "Jarvis", purpose: "Watch the deploys." });
      const second = yield* ask("look: two", "p2");
      assert.notStrictEqual(second.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 2);
      const text = launchedText(harness, 1);
      assert.isTrue(text.startsWith('## Identity\nThe person named you "Jarvis".'));
      assert.include(text, '"Watch the deploys."');
      assert.strictEqual(yield* sessionState(thread), "retired");
      // The same identity again keeps the session.
      harness.world.setStatus(second.worker!.threadId, 1, "completed", "Done.");
      yield* settle;
      const third = yield* ask("look: three", "p3");
      assert.strictEqual(third.worker?.threadId, second.worker?.threadId);
      assert.lengthOf(harness.world.launches, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("waits for a busy session before a rename replaces it, leaving its work alone", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "b1");
      const thread = first.worker!.threadId;
      yield* rename({ name: "Jarvis" });
      const waiting = yield* ask("look: two", "b2");
      assert.isUndefined(waiting.worker);
      assert.lengthOf(harness.world.launches, 1);
      assert.lengthOf(harness.world.sends, 0);
      assert.strictEqual(yield* sessionState(thread), "active");
      assert.strictEqual((yield* current(first.taskId)).worker?.threadId, thread);
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      const rotated = yield* current(waiting.taskId);
      assert.notStrictEqual(rotated.worker?.threadId, thread);
      assert.isTrue(launchedText(harness, 1).startsWith("## Identity\n"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("renaming back to the defaults rotates once more to the plain prefix", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* rename({ name: "Jarvis" });
      const first = yield* ask("look: one", "d1");
      assert.isTrue(launchedText(harness, 0).startsWith("## Identity\n"));
      harness.world.setStatus(first.worker!.threadId, 1, "completed", "Done.");
      yield* settle;
      yield* rename({ name: "GOAT Bot" });
      const second = yield* ask("look: two", "d2");
      assert.notStrictEqual(second.worker?.threadId, first.worker?.threadId);
      assert.isTrue(launchedText(harness, 1).startsWith("## Standing instructions\n"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not retire a renamed session whose work it cannot read", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "u1");
      const thread = first.worker!.threadId;
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      yield* rename({ name: "Jarvis" });
      harness.world.recordFailures.add(thread);
      const waiting = yield* ask("look: two", "u2");
      assert.isUndefined(waiting.worker);
      assert.lengthOf(harness.world.launches, 1);
      assert.strictEqual(yield* sessionState(thread), "active");
      harness.world.recordFailures.delete(thread);
      yield* settle;
      assert.notStrictEqual((yield* current(waiting.taskId)).worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails a stored request visibly when the profile cannot be read, then recovers", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* rename({ name: "Jarvis" });
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const ingested = yield* gateway.ingest(goatInput("look: one", "f1"), rpcContext);
      yield* reception.receive(ingested.inputId, runtime.ownerToken);
      const taskId = taskIdFor(ingested.inputId, 0);
      assert.strictEqual((yield* current(taskId)).status, "received");
      const sql = yield* SqlClient.SqlClient;
      const key = "bot-profile:" + encodeURIComponent(ownerId) + ":main";
      const good = (yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${key}`)[0]!.value_json;
      yield* sql`UPDATE channel_runtime_state SET value_json = ${"bad json"} WHERE key = ${key}`;
      yield* runtime.drain;
      const failed = yield* current(taskId);
      assert.strictEqual(failed.status, "failed");
      assert.include(failed.resultSummary ?? "", "could not read its name and purpose");
      assert.lengthOf(harness.world.launches, 0);
      assert.lengthOf(harness.world.sends, 0);
      yield* sql`UPDATE channel_runtime_state SET value_json = ${good} WHERE key = ${key}`;
      const next = yield* ask("look: two", "f2");
      assert.isDefined(next.worker);
      assert.isTrue(launchedText(harness, 0).startsWith("## Identity\n"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("judges a session against its stored prefix after a restart", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-bot-profile-"));
    const harness = makeHarness({
      botWorkspace: true,
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        defaultRuntimeMode: "full-access",
        goatBotModelSelection: botModel,
      }).pipe(Layer.orDie),
      databaseLayer: SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ) as never,
    });
    harness.script.current = (input: ChannelReceptionInput) => {
      const text = input.inputText ?? "";
      return input.mode === "input" && text.startsWith("look:")
        ? Effect.succeed({
            replyText: "Looking now.",
            action: { type: "run_turn" as const, title: text.slice(5).trim(), instruction: text },
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      const thread = yield* Effect.gen(function* () {
        yield* setupBot;
        const first = yield* ask("look: one", "r1");
        harness.world.setStatus(first.worker!.threadId, 1, "completed", "Done.");
        yield* settle;
        yield* rename({ name: "Jarvis" });
        return first.worker!.threadId;
      }).pipe(Effect.provide(harness.layer));
      // A restarted server takes the workers over once the old owner's lease is stale.
      yield* TestClock.adjust("31 seconds");
      // Fresh services over the same database: the rename is judged from what was stored.
      yield* Effect.gen(function* () {
        const second = yield* ask("look: two", "r2");
        assert.notStrictEqual(second.worker?.threadId, thread);
        assert.isTrue(launchedText(harness, 1).startsWith("## Identity\n"));
        harness.world.setStatus(second.worker!.threadId, 1, "completed", "Done.");
        yield* settle;
      }).pipe(Effect.provide(harness.layer));
      yield* TestClock.adjust("31 seconds");
      yield* Effect.gen(function* () {
        const third = yield* ask("look: three", "r3");
        assert.lengthOf(harness.world.launches, 2);
        assert.isDefined(third.worker);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true }))));
  });
});
