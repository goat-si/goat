import { assert, describe, it } from "@effect/vitest";
import { BotId, CommandId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Profiles from "./ChannelBotProfiles.ts";
import * as Registry from "./ChannelBotRegistry.ts";
import * as Ledger from "./ChannelLedger.ts";
import {
  botThreadId,
  environmentId,
  makeHarness,
  owner,
  ownerId,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const main = BotId.make("main");
const mainKey = "bot-profile:" + encodeURIComponent(ownerId) + ":main";
const storedMain = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly value_json: string }>`
    SELECT value_json FROM channel_runtime_state WHERE key = ${mainKey}`)[0]?.value_json;
});

describe("ChannelBotProfiles", () => {
  it.effect("an edit changes only the sent keys and is what the next list returns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      const before = (yield* profiles.list(owner))[0]!;
      const renamed = yield* profiles.update({ botId: main, name: "Jarvis", avatar: "🦊" }, owner);
      assert.strictEqual(renamed.name, "Jarvis");
      assert.strictEqual(renamed.avatar, "🦊");
      assert.strictEqual(renamed.purpose, "");
      assert.strictEqual(renamed.sessionThreadId, botThreadId);
      const purposed = yield* profiles.update(
        { botId: main, purpose: "Watch the deploys." },
        owner,
      );
      assert.strictEqual(purposed.name, "Jarvis");
      assert.strictEqual(purposed.avatar, "🦊");
      const cleared = yield* profiles.update({ botId: main, avatar: null }, owner);
      assert.isNull(cleared.avatar);
      const listed = (yield* profiles.list(owner))[0]!;
      assert.deepStrictEqual(
        { name: listed.name, avatar: listed.avatar, purpose: listed.purpose },
        { name: "Jarvis", avatar: null, purpose: "Watch the deploys." },
      );
      assert.strictEqual(listed.createdAt, before.createdAt);
      // The main row keeps not storing its thread; list joins it from the bot record.
      assert.notInclude((yield* storedMain) ?? "", botThreadId);
      assert.deepStrictEqual(yield* profiles.identity(ownerId, main), {
        name: "Jarvis",
        purpose: "Watch the deploys.",
      });
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "refuses an edit to a bot that does not exist, before and after GOAT Bot exists",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const profiles = yield* Profiles.ChannelBotProfiles;
        const early = yield* Effect.flip(profiles.update({ botId: main, name: "Jarvis" }, owner));
        assert.strictEqual(early.reason, "not_found");
        assert.isUndefined(yield* storedMain);
        yield* setupBot;
        const unknown = yield* Effect.flip(
          profiles.update({ botId: BotId.make("ghost"), name: "Ghost" }, owner),
        );
        assert.strictEqual(unknown.reason, "not_found");
        assert.lengthOf(yield* profiles.list(owner), 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("never edits another owner's bot", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      yield* profiles.update({ botId: main, name: "Jarvis" }, owner);
      const stranger = { ...owner, ownerId: "channel-owner:someone-else" };
      const refused = yield* Effect.flip(
        profiles.update({ botId: main, name: "Mallory" }, stranger),
      );
      assert.strictEqual(refused.reason, "not_found");
      assert.strictEqual((yield* profiles.list(owner))[0]?.name, "Jarvis");
      assert.deepStrictEqual(yield* profiles.identity(stranger.ownerId, main), {
        name: "GOAT Bot",
        purpose: "",
      });
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("a corrupt profile row refuses the edit and writes nothing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      yield* profiles.update({ botId: main, name: "Jarvis" }, owner);
      const before = yield* storedMain;
      const sql = yield* SqlClient.SqlClient;
      const memberKey = "bot-profile:" + encodeURIComponent(ownerId) + ":helper";
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${memberKey}, ${"bad json"}, ${"2026-10-12T00:00:00.000Z"})`;
      const error = yield* Effect.flip(profiles.update({ botId: main, name: "Other" }, owner));
      assert.strictEqual(error.reason, "persistence_failed");
      assert.strictEqual(yield* storedMain, before);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("reads the identity from the main row alone, default until it is edited", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const profiles = yield* Profiles.ChannelBotProfiles;
      const fallback = { name: "GOAT Bot", purpose: "" };
      assert.deepStrictEqual(yield* profiles.identity(ownerId, main), fallback);
      yield* setupBot;
      assert.deepStrictEqual(yield* profiles.identity(ownerId, main), fallback);
      yield* profiles.update({ botId: main, name: "Jarvis" }, owner);
      // A replaced bot thread keeps the profile; the identity does not depend on the bot record.
      const ledger = yield* Ledger.ChannelLedger;
      yield* ledger.replaceBot({
        ownerId,
        previousThreadId: botThreadId,
        bot: { environmentId, projectId: scratchProjectId, threadId: ThreadId.make("next-bot") },
        now: "2026-10-12T00:00:01.000Z",
      });
      assert.deepStrictEqual(yield* profiles.identity(ownerId, main), {
        name: "Jarvis",
        purpose: "",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_runtime_state SET value_json = ${"bad json"} WHERE key = ${mainKey}`;
      assert.strictEqual(
        (yield* Effect.flip(profiles.identity(ownerId, main))).reason,
        "persistence_failed",
      );
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("lists no bots and starts none before GOAT Bot exists", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const profiles = yield* Profiles.ChannelBotProfiles;
      assert.deepStrictEqual(yield* profiles.list(owner), []);
      assert.isEmpty(harness.world.launches);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("adopts the canonical bot thread as the main bot, keeping its thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      const first = yield* profiles.list(owner);
      assert.lengthOf(first, 1);
      assert.strictEqual(first[0]?.role, "main");
      assert.strictEqual(first[0]?.sessionThreadId, botThreadId);
      assert.strictEqual((yield* profiles.list(owner))[0]?.createdAt, first[0]?.createdAt);
      assert.isEmpty(harness.world.launches);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("follows the bot thread when a deleted bot is replaced", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      const before = (yield* profiles.list(owner))[0];
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-profile-bot"),
        threadId: botThreadId,
      });
      const registry = yield* Registry.ChannelBotRegistry;
      const replacement = yield* registry.ensure({}, owner);
      assert.notStrictEqual(replacement.threadId, botThreadId);
      const after = (yield* profiles.list(owner))[0];
      assert.strictEqual(after?.sessionThreadId, replacement.threadId);
      assert.strictEqual(after?.createdAt, before?.createdAt);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("a corrupt profile row fails the list and leaves the bot usable", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      yield* profiles.list(owner);
      const sql = yield* SqlClient.SqlClient;
      const key = "bot-profile:" + encodeURIComponent(ownerId) + ":main";
      yield* sql`UPDATE channel_runtime_state SET value_json = ${"bad json"} WHERE key = ${key}`;
      const error = yield* Effect.flip(profiles.list(owner));
      assert.strictEqual(error.reason, "persistence_failed");
      const registry = yield* Registry.ChannelBotRegistry;
      assert.strictEqual((yield* registry.ensure({}, owner)).threadId, botThreadId);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("a bot replaced after the main profile was adopted lists the replacement", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const profiles = yield* Profiles.ChannelBotProfiles;
      const before = (yield* profiles.list(owner))[0];
      const ledger = yield* Ledger.ChannelLedger;
      const replacement = ThreadId.make("replacement-profile-thread");
      yield* ledger.replaceBot({
        ownerId,
        previousThreadId: botThreadId,
        bot: { environmentId, projectId: scratchProjectId, threadId: replacement },
        now: "2026-10-12T00:00:01.000Z",
      });
      const after = (yield* profiles.list(owner))[0];
      assert.strictEqual(after?.sessionThreadId, replacement);
      assert.strictEqual(after?.createdAt, before?.createdAt);
    }).pipe(Effect.provide(harness.layer));
  });
});
