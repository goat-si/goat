import { assert, describe, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@goat/contracts";
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

describe("ChannelBotProfiles", () => {
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
