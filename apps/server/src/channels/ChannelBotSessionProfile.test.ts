import { launchBrief } from "./testkit/providerBrief.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { BotId, type ChannelConversationId, type ChannelReceptionInput } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { goatBotSessionThreadIdFor, taskIdFor } from "./channelIds.ts";
import { ask, botModel, current, sessionHarness, settle } from "./ChannelBotSession.testkit.ts";
import {
  defaultScript,
  environmentId,
  goatInput,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const main = BotId.make("main");
const rename = (fields: {
  readonly name?: string;
  readonly purpose?: string;
  readonly instructions?: string;
}) =>
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
  launchBrief(harness.world.launches[index]);

describe("GOAT Bot sessions and the bot's profile", () => {
  it.effect("keeps another bot's journal out of the session-first model input", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const create = (name: string) =>
        members.create(
          { clientRequestId: name, name, avatar: null, purpose: "", defaultModelSelection: null },
          owner,
        );
      const scout = yield* create("Scout");
      const review = yield* create("Review buddy");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const send = (member: typeof scout, message: string, key: string) =>
        gateway
          .ingest(
            {
              ...goatInput(message, key),
              conversationKey: member.sessionThreadId,
              replyAddress: { kind: "goat", environmentId, threadId: member.sessionThreadId },
            },
            rpcContext,
          )
          .pipe(Effect.tap(() => runtime.drain));
      const privateFact = "Scout rollout key synthetic-juniper";
      const first = yield* send(scout, privateFact, "scout-journal");
      const scoutTask = yield* current(taskIdFor(first.inputId, 0));
      assert.isDefined(scoutTask.worker);
      assert.strictEqual(scoutTask.title, privateFact);

      const second = yield* send(review, "Review the launch checklist", "review-journal");
      const worker = (yield* current(taskIdFor(second.inputId, 0))).worker;
      const input = harness.world.launches.find((launch) => launch.threadId === worker?.threadId);
      assert.include(yield* launchBrief(input), "Review the launch checklist");
      assert.notInclude(yield* launchBrief(input), privateFact);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a rename starts the next idle request in a new session that knows the name", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* ask("look: one", "p1");
      const thread = first.worker!.threadId;
      assert.isTrue((yield* launchedText(harness, 0)).startsWith("## Standing instructions\n"));
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      yield* rename({ name: "Jarvis", purpose: "Watch the deploys." });
      const second = yield* ask("look: two", "p2");
      assert.notStrictEqual(second.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 2);
      const text = yield* launchedText(harness, 1);
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

  it.effect("saving and clearing instructions each rotate the warm session", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const initial = yield* ask("look: check build one", "instructions-before");
      const first = initial.worker?.threadId;
      if (first === undefined) return yield* Effect.die("The initial session did not start");
      harness.world.setStatus(first, 1, "completed", "Done.");
      yield* settle;

      const instruction = "Read the release checklist before reporting.";
      yield* rename({ instructions: instruction });
      const saved = yield* ask("look: check build two", "instructions-saved");
      const second = saved.worker?.threadId;
      if (second === undefined) return yield* Effect.die("The edited session did not start");
      assert.notStrictEqual(second, first);
      assert.strictEqual(yield* sessionState(first), "retired");
      assert.include(yield* launchedText(harness, 1), instruction);
      harness.world.setStatus(second, 1, "completed", "Done.");
      yield* settle;

      yield* rename({ instructions: "" });
      const cleared = yield* ask("look: check build three", "instructions-cleared");
      assert.isDefined(cleared.worker);
      assert.notStrictEqual(cleared.worker?.threadId, second);
      assert.strictEqual(yield* sessionState(second), "retired");
      assert.notInclude(yield* launchedText(harness, 2), instruction);
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
      assert.isTrue((yield* launchedText(harness, 1)).startsWith("## Identity\n"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("renaming back to the defaults rotates once more to the plain prefix", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* rename({ name: "Jarvis" });
      const first = yield* ask("look: one", "d1");
      assert.isTrue((yield* launchedText(harness, 0)).startsWith("## Identity\n"));
      harness.world.setStatus(first.worker!.threadId, 1, "completed", "Done.");
      yield* settle;
      yield* rename({ name: "GOAT Bot" });
      const second = yield* ask("look: two", "d2");
      assert.notStrictEqual(second.worker?.threadId, first.worker?.threadId);
      assert.isTrue((yield* launchedText(harness, 1)).startsWith("## Standing instructions\n"));
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

  it.effect("keeps an unfinished launch it cannot read for another task", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* ask("look: one", "s1");
      const thread = first.worker!.threadId;
      // As if the launch had not been marked live, while its thread cannot be read.
      yield* sql`UPDATE channel_bot_sessions SET state = 'starting' WHERE thread_id = ${thread}`;
      harness.world.recordFailures.add(thread);
      const waiting = yield* ask("look: two", "s2");
      assert.isUndefined(waiting.worker);
      assert.strictEqual(yield* sessionState(thread), "starting");
      harness.world.recordFailures.delete(thread);
      yield* settle;
      assert.strictEqual(yield* sessionState(thread), "active");
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
      assert.isTrue((yield* launchedText(harness, 0)).startsWith("## Identity\n"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resumes its own unfinished launch with the prefix it froze, then rotates", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const first = yield* ask("look: one", "o1");
      const thread = first.worker!.threadId;
      harness.world.setStatus(thread, 1, "completed", "Done.");
      yield* settle;
      const ingested = yield* gateway.ingest(goatInput("look: two", "o2"), rpcContext);
      yield* reception.receive(ingested.inputId, runtime.ownerToken);
      const waiting = yield* current(taskIdFor(ingested.inputId, 0));
      // As if the process died after allocating the next generation for this task, before its
      // launch, with the prefix frozen before the rename below.
      const next = goatBotSessionThreadIdFor(waiting.conversationId as ChannelConversationId, 2);
      yield* sql`UPDATE channel_bot_sessions SET state = 'retired' WHERE thread_id = ${thread}`;
      yield* sql`
        INSERT INTO channel_bot_sessions (conversation_id, generation, binding_key, thread_id,
          task_id, task_generation, state, driver_kind, sharing, model_instance_id, model,
          requester_json, context_revision, context_text, created_at)
        SELECT conversation_id, 2, binding_key, ${next}, ${waiting.taskId}, ${waiting.generation},
          'starting', driver_kind, sharing, model_instance_id, model, requester_json,
          context_revision, context_text, created_at
        FROM channel_bot_sessions WHERE thread_id = ${thread}
      `;
      yield* rename({ name: "Jarvis" });
      yield* runtime.drain;
      assert.strictEqual((yield* current(waiting.taskId)).worker?.threadId, next);
      assert.isTrue((yield* launchedText(harness, 1)).startsWith("## Standing instructions\n"));
      harness.world.setStatus(next, 1, "completed", "Done.");
      yield* settle;
      const third = yield* ask("look: three", "o3");
      assert.notStrictEqual(third.worker?.threadId, next);
      assert.isTrue(
        (yield* launchedText(harness, 2)).startsWith('## Identity\nThe person named you "Jarvis".'),
      );
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
        assert.isTrue((yield* launchedText(harness, 1)).startsWith("## Identity\n"));
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
