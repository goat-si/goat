import { assert, describe, it } from "@effect/vitest";
import { ChannelGatewayError, ChannelOutboundMessage, type ChannelTaskId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { deliveryIdFor } from "./channelIds.ts";
import {
  botMessages,
  linkSlackUser,
  makeHarness,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const decodeOutbound = Schema.decodeUnknownSync(ChannelOutboundMessage);
const NOW = "2026-10-12T00:00:00.000Z";
const OWNER = "channel-owner:a";
const slack = {
  kind: "slack",
  connectionId: "slack-1",
  teamId: "T1",
  channelId: "C1",
  rootTs: "1",
};

const delivery = (causeKey: string, taskId?: string) => ({
  deliveryId: deliveryIdFor(causeKey),
  causeKey,
  ...(taskId === undefined ? {} : { taskId: taskId as ChannelTaskId }),
  message: decodeOutbound({
    deliveryId: deliveryIdFor(causeKey),
    destination: slack,
    kind: "receipt",
    text: causeKey,
  }),
});

/** A worker whose transport hangs on the first send, as a process that dies mid-send would. */
const layerHangingSend = (started: Deferred.Deferred<void>) =>
  ChannelDeliveryWorker.layer.pipe(
    Layer.provideMerge(
      Layer.mock(ChannelGateway.ChannelGateway)({
        send: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    ),
    Layer.provide(ChannelWake.layer),
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

describe("ChannelDeliveryWorker", () => {
  it.effect("leaves rows it never started pending when the process stops mid-send", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        yield* TestClock.setTime(Date.parse(NOW));
        assert.isTrue(
          yield* ledger.claimOwnership({
            token: OWNER,
            now: NOW,
            staleBefore: "2026-10-11T23:59:30.000Z",
          }),
        );
        yield* ledger.enqueueDeliveries([delivery("first"), delivery("second")], NOW);
        const pass = yield* Effect.forkChild(worker.deliverDue(OWNER));
        // Fails fast instead of hanging if the pass ends without starting a send.
        yield* Effect.raceFirst(
          Deferred.await(started),
          Fiber.join(pass).pipe(Effect.andThen(Effect.die("the pass never started a send"))),
        );
        yield* Fiber.interrupt(pass);
        // The next owner settles what the dead one left behind.
        yield* ledger.settleInterruptedDeliveries({ owner: OWNER, now: NOW });
        assert.strictEqual(yield* ledger.getDeliveryState(deliveryIdFor("first")), "ambiguous");
        assert.strictEqual(yield* ledger.getDeliveryState(deliveryIdFor("second")), "pending");
      }).pipe(Effect.provide(layerHangingSend(started)));
    }),
  );
});

const assistantCopies = (lead: string) =>
  Effect.map(botMessages, (records) =>
    records.messages.filter(
      (message) => message.role === "assistant" && message.text.startsWith(lead),
    ),
  );

describe("undelivered replies", () => {
  it.effect("a Slack reply that fails for good shows in the GOAT Bot chat once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* runtime.drain;
      harness.slackFailures.push(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "not_sent",
          deliveryErrorCode: "token_revoked",
        }),
      );
      const input = yield* gateway.ingest(slackInput("hello", "undelivered-fail"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(
        yield* ledger.getDeliveryState(deliveryIdFor("reply:" + input.inputId)),
        "failed",
      );
      const copies = yield* assistantCopies("This reply didn't reach Slack");
      assert.strictEqual(copies.length, 1);
      assert.strictEqual(copies[0]?.text, "This reply didn't reach Slack:\n\nOkay.");
      yield* runtime.drain;
      assert.strictEqual((yield* assistantCopies("This reply didn't reach Slack")).length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a reply interrupted by a restart is shown as maybe not delivered", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* runtime.drain;
      const input = yield* gateway.ingest(
        slackInput("ship it", "undelivered-interrupt"),
        slackContext,
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const reply = "The branch is ready.";
      const causeKey = "reply:" + input.inputId;
      const deliveryId = deliveryIdFor(causeKey);
      yield* ledger.enqueueDeliveries(
        [
          {
            deliveryId,
            causeKey,
            inputId: input.inputId,
            message: {
              deliveryId,
              destination: slackInput("ship it", "undelivered-interrupt").replyAddress,
              kind: "result",
              text: reply,
              inReplyToInputId: input.inputId,
            },
          },
        ],
        now,
      );
      const claimed = yield* ledger.claimDueDeliveries({
        owner: runtime.ownerToken,
        now,
        limit: 1,
        receiptsOnly: true,
      });
      assert.strictEqual(claimed[0]?.deliveryId, deliveryId);
      yield* ledger.settleInterruptedDeliveries({ owner: runtime.ownerToken, now });
      assert.strictEqual(yield* ledger.getDeliveryState(deliveryId), "ambiguous");
      yield* runtime.drain;
      const copies = yield* assistantCopies("This reply may not have reached Slack");
      assert.strictEqual(copies.length, 1);
      assert.strictEqual(
        copies[0]?.text,
        "This reply may not have reached Slack (GOAT stopped while sending it):\n\n" + reply,
      );
      yield* runtime.drain;
      assert.strictEqual(
        (yield* assistantCopies("This reply may not have reached Slack")).length,
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
