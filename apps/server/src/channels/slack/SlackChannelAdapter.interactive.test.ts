import { ChannelDeliveryId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";

import {
  handleSlackEnvelope,
  makeSlackChannelTransport,
  type SlackActiveSession,
} from "./SlackChannelAdapter.ts";
import { makeFakeGateway, owner } from "./slackChannelTestSupport.ts";
import type { SlackBotApi, SlackSocketEnvelope } from "./SlackSdk.ts";

const classifier = {
  teamId: "T0TEAM",
  botUserId: "U0BOT",
  allowedChannelIds: new Set(["C0ALLOWED"]),
};
const connectionId = "slack-0123456789ab";

const envelopeFor = (body: unknown, type = "interactive") => {
  let acks = 0;
  const envelope: SlackSocketEnvelope = {
    envelopeId: "env-interactive",
    type,
    body,
    retryNum: undefined,
    retryReason: undefined,
    ack: () => {
      acks += 1;
      return Promise.resolve();
    },
  };
  return { envelope, acks: () => acks };
};

const blockActions = (
  overrides: {
    readonly userId?: string;
    readonly channelId?: string;
    readonly teamId?: string;
    readonly threadTs?: string;
    readonly actions?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) => ({
  type: "block_actions",
  team: { id: overrides.teamId ?? "T0TEAM" },
  user: { id: overrides.userId ?? "U0ALICE", username: "alice" },
  channel: { id: overrides.channelId ?? "C0ALLOWED", name: "general" },
  message: {
    ts: "1760000000.000200",
    thread_ts: overrides.threadTs ?? "1760000000.000100",
    text: "card",
  },
  actions: overrides.actions ?? [
    {
      type: "button",
      action_id: "goat_choice_1",
      value: "Approve A1",
      action_ts: "1760000001.000100",
    },
  ],
  token: "xoxb-secret",
  response_url: "https://hooks.slack.com/actions/nope",
  trigger_id: "1337.not.used",
});

describe("Slack choice buttons", () => {
  it.effect("ingests a choice button as the clicking user's message", () => {
    const gateway = makeFakeGateway();
    const { envelope, acks } = envelopeFor(blockActions());
    return Effect.gen(function* () {
      const result = yield* handleSlackEnvelope(envelope, { connectionId, classifier, owner });
      assert.deepEqual(result, { acked: true, handling: "ingested" });
      assert.equal(acks(), 1);
      const ingest = gateway.calls.find((call) => call.method === "ingest");
      assert.equal(ingest?.method, "ingest");
      if (ingest?.method !== "ingest") return;
      assert.equal(ingest.input.text, "Approve A1");
      assert.deepEqual(ingest.input.actor, { externalActorId: "U0ALICE" });
      assert.equal(ingest.input.intent, "message");
      assert.equal(ingest.input.conversationKey, "T0TEAM:C0ALLOWED:1760000000.000100");
      assert.equal(
        ingest.input.idempotencyKey,
        "T0TEAM:ia:C0ALLOWED:1760000000.000100:U0ALICE:goat_choice_1:1760000001.000100",
      );
      if (ingest.input.replyAddress.kind === "slack") {
        assert.equal(ingest.input.replyAddress.rootTs, "1760000000.000100");
        assert.equal(ingest.input.replyAddress.channelId, "C0ALLOWED");
      }
      assert.equal(JSON.stringify(gateway.calls).includes("xoxb-secret"), false);
      assert.equal(JSON.stringify(gateway.calls).includes("hooks.slack.com"), false);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("acks other interactive payloads and foreign action ids without ingesting", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      for (const body of [
        { type: "shortcut", callback_id: "goat" },
        { type: "view_submission", view: { id: "V1" } },
        blockActions({
          actions: [{ action_id: "approve", value: "Approve A1", action_ts: "1760000001.000100" }],
        }),
        blockActions({
          actions: [
            { action_id: "not_ours", value: "nope", action_ts: "1760000001.000100" },
            {
              action_id: "goat_choice_2",
              value: "Deny A1",
              action_ts: "1760000001.000200",
            },
          ],
        }),
      ]) {
        const { envelope } = envelopeFor(body);
        const result = yield* handleSlackEnvelope(envelope, { connectionId, classifier, owner });
        assert.equal(result.acked, true);
      }
      const ingested = gateway.calls.filter((call) => call.method === "ingest");
      assert.equal(ingested.length, 1);
      assert.equal(
        ingested[0]?.method === "ingest" ? ingested[0].input.text : undefined,
        "Deny A1",
      );
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("posts choice buttons next to the numbered fallback text", () => {
    const posts: Array<Parameters<SlackBotApi["postMessage"]>[0]> = [];
    const session: SlackActiveSession = {
      generation: 1,
      teamId: "T0TEAM",
      botUserId: "U0BOT",
      botApi: {
        authTest: () => Promise.reject(new Error("not used")),
        postMessage: (input) => {
          posts.push(input);
          return Promise.resolve({ ts: "1760000002.000100" });
        },
      },
    };
    const transport = makeSlackChannelTransport({
      activeSession: () => Effect.succeed(Option.some(session)),
      reportFailure: () => Effect.void,
    });
    return Effect.gen(function* () {
      yield* transport.send({
        deliveryId: ChannelDeliveryId.make("delivery-1"),
        destination: {
          kind: "slack",
          connectionId,
          teamId: "T0TEAM",
          channelId: "C0ALLOWED",
          rootTs: "1760000000.000100",
        },
        kind: "question",
        text: "deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
        mentionActorId: "U0ALICE",
        options: ["Approve A1", "Deny A1"],
      });
      const [post] = posts;
      assert.equal(
        post?.text,
        "<@U0ALICE> deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
      );
      assert.deepEqual(post?.blocks, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "<@U0ALICE> deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
          },
        },
        {
          type: "actions",
          block_id: "goat_choices",
          elements: [
            {
              type: "button",
              action_id: "goat_choice_1",
              value: "Approve A1",
              text: { type: "plain_text", text: "Approve A1", emoji: false },
            },
            {
              type: "button",
              action_id: "goat_choice_2",
              value: "Deny A1",
              text: { type: "plain_text", text: "Deny A1", emoji: false },
            },
          ],
        },
      ]);
    });
  });
});
