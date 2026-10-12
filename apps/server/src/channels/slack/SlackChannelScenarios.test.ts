import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import { CHANNEL_COPY } from "../channelCopy.ts";
import { inputIdFor } from "../channelIds.ts";
import { makeHarness, owner, ownerId, setupBot } from "../testkit/ChannelHarness.ts";
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

const connect = (_sdk: FakeSlackSdk) =>
  Effect.gen(function* () {
    const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
    yield* runtime.apply({
      connectionId,
      enabled: true,
      allowedChannelIds: ["C0ALLOWED"],
      appToken: "xapp-1-test",
      botToken: "xoxb-test",
      expectedTeamId: "T0TEAM",
      owner,
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

describe("Slack runtime on the channel core", () => {
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
