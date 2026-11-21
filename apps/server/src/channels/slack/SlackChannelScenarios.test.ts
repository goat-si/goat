import { assert, describe, it } from "@effect/vitest";
import { BotId, type ChannelReceptionInput, type RuntimeMode } from "@goat/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ChannelBotMembers from "../ChannelBotMembers.ts";
import { channelBotFilesFor } from "../channelBotNotes.ts";
import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import { CHANNEL_COPY } from "../channelCopy.ts";
import { inputIdFor } from "../channelIds.ts";
import { defaultScript, makeHarness, owner, ownerId, setupBot } from "../testkit/ChannelHarness.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import { channelMention, directMessage, eventCallback } from "./slackChannelTestSupport.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

/**
 * The live Slack runtime against the real channel core: gateway, ledger, reception, and the
 * delivery worker from the channel test harness, with only the Slack SDK faked. These cover what
 * the adapter alone cannot prove: one stored input per Slack event, no work for unlinked users,
 * and how the outbox treats Slack's delivery failures.
 */

const connectionId = "slack-1";
const ROOT_TS = "1760000000.000100";

const slackScenario = () => {
  const sdk = makeFakeSlackSdk();
  const harness = makeHarness({ fakeSlackTransport: false });
  const layer = SlackChannelRuntime.layer.pipe(
    Layer.provide(sdk.layer),
    Layer.provideMerge(harness.layer),
  );
  return { sdk, harness, layer };
};

const connect = (
  _sdk: FakeSlackSdk,
  options: {
    readonly botBindings?: ReadonlyArray<{ readonly channelId: string; readonly botId: BotId }>;
    readonly unlinkedRuntimeModeCeiling?: RuntimeMode;
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
    yield* runtime.apply({
      connectionId,
      enabled: true,
      channelScope: "listed",
      allowedChannelIds: ["C0ALLOWED"],
      appToken: "xapp-1-test",
      botToken: "xoxb-test",
      expectedTeamId: "T0TEAM",
      owner,
      ...options,
    });
    yield* runtime.streamStatus.pipe(
      Stream.filter((event) => event.connectionId === connectionId && event.status === "connected"),
      Stream.runHead,
    );
  });

const emit = (sdk: FakeSlackSdk, event: Record<string, unknown>, eventId: string) => {
  const session = sdk.sessions.at(-1);
  assert(session !== undefined);
  const envelope = session.emitEnvelope(eventCallback(event, { event_id: eventId }));
  return Effect.promise(() => envelope.acked).pipe(Effect.as(envelope));
};

const linkAlice = (sdk: FakeSlackSdk) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      { connectionId, runtimeModeCeiling: "auto-accept-edits" },
      owner,
    );
    yield* emit(sdk, directMessage({ text: `link ${code}` }), "EvLinkAlice01");
  });

const tasks = Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) =>
  ledger.listTasks({ ownerId, limit: 10 }),
);

const createBot = (name: string) =>
  Effect.flatMap(ChannelBotMembers.ChannelBotMembers, (members) =>
    members.create(
      { clientRequestId: name, name, purpose: "", avatar: null, defaultModelSelection: null },
      owner,
    ),
  );

const eventInputId = (eventId: string) =>
  inputIdFor({ ownerId, kind: "slack", connectionId, idempotencyKey: "T0TEAM:" + eventId });

const receive = (sdk: FakeSlackSdk, event: Record<string, unknown>, eventId: string) =>
  Effect.gen(function* () {
    yield* emit(sdk, event, eventId);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    return yield* (yield* ChannelLedger.ChannelLedger).getInput(eventInputId(eventId));
  });

describe("Slack runtime on the channel core", () => {
  it.effect(
    "pins the first admitted Slack message across rebinding, renaming and unbinding",
    () => {
      const { sdk, layer } = slackScenario();
      return Effect.gen(function* () {
        yield* setupBot;
        const scout = yield* createBot("Scout");
        const builder = yield* createBot("Builder");
        yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
        yield* linkAlice(sdk);
        const first = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> do: check the build", ts: ROOT_TS }),
          "EvNamedBound01",
        );
        assert.strictEqual(first?.botId, scout.botId);
        assert.include(sdk.posted.find((post) => post.threadTs === ROOT_TS)?.text ?? "", "Scout:");
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        yield* members.update({ botId: scout.botId, name: "Navigator" }, owner);
        yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: builder.botId }] });
        const reply = yield* receive(
          sdk,
          channelMention({
            text: "<@U0BOT> Builder: status?",
            ts: "1760000001.000101",
            thread_ts: ROOT_TS,
          }),
          "EvNamedReply01",
        );
        assert.strictEqual(reply?.botId, scout.botId);
        yield* connect(sdk);
        const unbound = yield* receive(
          sdk,
          channelMention({ ts: "1760000002.000102" }),
          "EvNamedUnbound",
        );
        assert.strictEqual(unbound?.botId, "main");
        const dm = yield* receive(
          sdk,
          directMessage({ text: "navigator: do: check the logs" }),
          "EvNamedDm01",
        );
        assert.strictEqual(dm?.botId, scout.botId);
        assert.strictEqual(dm?.message.text, "do: check the logs");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps a Slack thread admitted by an older server with Main", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      const sql = yield* SqlClient.SqlClient;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const original = yield* receive(sdk, channelMention(), "EvLegacyFirst");
      assert.strictEqual(original?.botId, "main");
      // Simulate the row as an older writer leaves it after adding the nullable column.
      yield* sql`UPDATE channel_conversations SET slack_bot_id = NULL WHERE conversation_id = ${original?.snapshot.conversationId}`;
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
      const reply = yield* receive(
        sdk,
        channelMention({
          text: "<@U0BOT> Scout: hello",
          ts: "1760000002.000102",
          thread_ts: ROOT_TS,
        }),
        "EvLegacyReply",
      );
      assert.strictEqual(reply?.botId, "main");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps unknown, hidden, deleted and ambiguous targets private", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* createBot("Scout");
      const hidden = yield* createBot("Hidden");
      const retired = yield* createBot("Retired");
      const duplicate = yield* createBot("Duplicate");
      yield* members.setHidden({ botId: hidden.botId, hidden: true }, owner);
      yield* members.remove({ botId: retired.botId }, owner);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.name', 'SCOUT')
        WHERE json_extract(value_json, '$.botId') = ${duplicate.botId} AND key LIKE 'bot-profile:%'`;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      for (const [index, name] of ["Missing", "Hidden", "Retired", "Scout"].entries()) {
        const root = "1760000003.00010" + index;
        const rejected = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> " + name + ": do: check the build", ts: root }),
          "EvRouteDenied" + index,
        );
        assert.strictEqual(rejected?.snapshot.state, "rejected");
        assert.isFalse(sdk.posted.some((post) => post.threadTs === root));
      }
      assert.lengthOf((yield* tasks).tasks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a deleted bot's Slack thread private and starts no replacement work", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
      yield* linkAlice(sdk);
      yield* receive(sdk, channelMention(), "EvDeletedFirst");
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* members.remove({ botId: scout.botId }, owner);
      const publicCount = sdk.posted.length;
      const rejected = yield* receive(
        sdk,
        channelMention({
          text: "<@U0BOT> do: check the build",
          ts: "1760000004.000100",
          thread_ts: ROOT_TS,
        }),
        "EvDeletedReply",
      );
      assert.strictEqual(rejected?.snapshot.state, "rejected");
      assert.lengthOf(sdk.posted, publicCount);
      assert.lengthOf((yield* tasks).tasks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "routes an unlinked workspace sender to a member without supplying shared notes",
    () => {
      const { sdk, harness, layer } = slackScenario();
      const seen: Array<ChannelReceptionInput> = [];
      harness.script.current = (input) => {
        seen.push(input);
        return defaultScript(input);
      };
      return Effect.gen(function* () {
        yield* setupBot;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ goatBotSessionRouting: "reception" });
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(
          files.notes,
          "- 2026-03-01: The deploy secret is cobalt. (asked in channel-input:note)\n",
        );
        const scout = yield* createBot("Scout");
        yield* connect(sdk, {
          botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }],
          unlinkedRuntimeModeCeiling: "approval-required",
        });
        const result = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> What is the deploy secret?" }),
          "EvNamedUnlinked",
        );
        const reception = seen.find((entry) => entry.inputText === "What is the deploy secret?");
        assert.isDefined(reception);
        assert.isUndefined(reception?.notes);
        assert.strictEqual(result?.botId, scout.botId);
        assert.strictEqual(reception?.identity?.name, "Scout");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("stores one input and one task for an event Slack sends twice", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const mention = channelMention({ text: "<@U0BOT> do: fix the login bug", ts: ROOT_TS });
      const first = yield* emit(sdk, mention, "EvMention0001");
      const retry = yield* emit(sdk, mention, "EvMention0001");
      assert.equal(first.ackCount() + retry.ackCount(), 2);
      yield* runtime.drain;
      // Both deliveries map to one stored input, which started the one task.
      const ledger = yield* ChannelLedger.ChannelLedger;
      const inputId = inputIdFor({
        ownerId,
        kind: "slack",
        connectionId,
        idempotencyKey: "T0TEAM:EvMention0001",
      });
      assert.isDefined(yield* ledger.getInput(inputId));
      const page = yield* tasks;
      assert.equal(page.tasks.length, 1);
      assert.equal(page.tasks[0]?.originInputId, inputId);
      // The receipt goes to the thread root and tags the requester.
      const receipts = sdk.posted.filter((post) => post.threadTs === ROOT_TS);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.channel, "C0ALLOWED");
      assert(receipts[0]?.text.startsWith("<@U0ALICE>"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers an unlinked user with the link notice and starts no work", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const envelope = yield* emit(
        sdk,
        channelMention({ text: "<@U0BOT> do: delete everything", ts: ROOT_TS }),
        "EvUnlinked001",
      );
      assert.equal(envelope.ackCount(), 1);
      yield* runtime.drain;
      assert.equal((yield* tasks).tasks.length, 0);
      const notices = sdk.posted.filter((post) => post.threadTs === ROOT_TS);
      assert.equal(notices.length, 1);
      assert(notices[0]?.text.includes(CHANNEL_COPY.unlinkedInput.slice(0, 20)));
    }).pipe(Effect.provide(layer));
  });

  it.effect("waits out Retry-After and never repeats a send that may have arrived", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const before = sdk.posted.length;

      sdk.script.postMessage = () =>
        Promise.reject(sdk.failure("chat.postMessage", "rate_limited", 30));
      yield* emit(sdk, channelMention({ text: "<@U0BOT> status?", ts: ROOT_TS }), "EvRate000001");
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 1);
      sdk.script.postMessage = () => Promise.resolve({ ts: "1760000009.000100" });
      yield* TestClock.adjust(Duration.seconds(29));
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 1, "retried before Retry-After");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 2);

      const otherRoot = "1760000000.000300";
      sdk.script.postMessage = () => Promise.reject(sdk.failure("chat.postMessage", "timeout"));
      yield* emit(sdk, channelMention({ text: "<@U0BOT> status?", ts: otherRoot }), "EvTimeout001");
      yield* runtime.drain;
      sdk.script.postMessage = () => Promise.resolve({ ts: "1760000009.000200" });
      yield* TestClock.adjust(Duration.minutes(30));
      yield* runtime.drain;
      assert.equal(sdk.posted.filter((post) => post.threadTs === otherRoot).length, 1);
    }).pipe(Effect.provide(layer));
  });
});
