import { assert, describe, it } from "@effect/vitest";
import { ChannelOutboundMessage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as AutomationHold from "../automationHold.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { deliveryIdFor } from "./channelIds.ts";
import * as ImessageChannelRuntime from "./imessage/ImessageChannelRuntime.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import {
  defaultScript,
  linkSlackUser,
  makeHarness,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const decodeOutbound = Schema.decodeUnknownEffect(ChannelOutboundMessage);

describe("iMessage poll isolation", () => {
  it.effect(
    "holds channel polling, dispatch and outbound delivery, then wakes the backlog on release",
    () => {
      let polls = 0;
      const channelsLayer = ChannelLayers.makeLayerServices(
        SlackChannelSettings.layerUnavailable,
        Layer.succeed(ImessageChannelRuntime.ImessageChannelRuntime, {
          pollDue: () =>
            Effect.sync(() => {
              polls += 1;
              return 0;
            }),
        }),
      );
      const harness = makeHarness({ channelsLayer });
      return Effect.gen(function* () {
        const hold = yield* AutomationHold.makeInMemory({
          reason: "channel-copy",
          heldAt: "2026-10-25T00:00:00.000Z",
        });
        yield* Effect.gen(function* () {
          yield* setupBot;
          yield* linkSlackUser();
          const gateway = yield* ChannelGateway.ChannelGateway;
          const ledger = yield* ChannelLedger.ChannelLedger;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          const receiving = yield* Deferred.make<void>();
          harness.script.current = (input) =>
            Deferred.succeed(receiving, undefined).pipe(Effect.andThen(defaultScript(input)));
          const dispatched = yield* Deferred.make<void>();
          harness.launch.afterAccepted = () =>
            Deferred.succeed(dispatched, undefined).pipe(Effect.asVoid);
          const input = yield* gateway.ingest(slackInput("do: held job", "held-job"), slackContext);
          yield* Layer.build(ChannelRuntime.layerBackground);
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual(yield* runtime.runPass, 0);
          assert.strictEqual(polls, 0);
          assert.deepStrictEqual(harness.slackSent, []);
          assert.deepStrictEqual(harness.world.launches, []);
          assert.strictEqual((yield* ledger.getInput(input.inputId))?.snapshot.state, "accepted");

          yield* hold.release;
          yield* Deferred.await(receiving);
          yield* runtime.settle([input.inputId]);
          yield* TestClock.adjust("5 seconds");
          yield* Deferred.await(dispatched);
          assert.isAbove(polls, 0);
          assert.isAbove(harness.slackSent.length, 0);
          assert.strictEqual(harness.world.launches.length, 1);
        }).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(AutomationHold.AutomationHold, hold),
        );
      });
    },
  );

  it.effect("continues Slack reception and delivery in the same pass after a read failure", () => {
    let polls = 0;
    const channelsLayer = ChannelLayers.makeLayerServices(
      SlackChannelSettings.layerUnavailable,
      Layer.succeed(
        ImessageChannelRuntime.ImessageChannelRuntime,
        ImessageChannelRuntime.ImessageChannelRuntime.of({
          pollDue: () => {
            polls += 1;
            return Effect.fail(
              new ChannelLedger.ChannelLedgerError({
                reason: "persistence",
                detail: "iMessage database database_unavailable",
              }),
            );
          },
        }),
      ),
    );
    const harness = makeHarness({ channelsLayer });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const input = yield* gateway.ingest(slackInput("hello", "imsg-read-failure"), slackContext);
      const deliveryId = deliveryIdFor("imsg-independent-delivery");
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.enqueueDeliveries(
        [
          {
            deliveryId,
            causeKey: "imsg-independent-delivery",
            message: yield* decodeOutbound({
              deliveryId,
              destination: {
                kind: "slack",
                connectionId: "slack-1",
                teamId: "T1",
                channelId: "C1",
                rootTs: "1",
              },
              kind: "receipt",
              text: "independent delivery",
            }),
          },
        ],
        now,
      );
      assert.isTrue(
        yield* ledger.claimOwnership({
          token: runtime.ownerToken,
          now,
          staleBefore: DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, "30 seconds"),
          ),
        }),
      );
      yield* runtime.runPass;
      assert.strictEqual(polls, 1);
      assert.strictEqual(yield* ledger.getDeliveryState(deliveryId), "delivered");
      assert.isTrue(harness.slackSent.some((sent) => sent.message.deliveryId === deliveryId));
      yield* runtime.settle([input.inputId]);
      assert.strictEqual((yield* ledger.getInput(input.inputId))?.snapshot.state, "replied");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect.each(["ownership_lost", "version_conflict"] as const)(
    "stops the pass when the iMessage poll loses its %s fence",
    (reason) => {
      const channelsLayer = ChannelLayers.makeLayerServices(
        SlackChannelSettings.layerUnavailable,
        Layer.succeed(
          ImessageChannelRuntime.ImessageChannelRuntime,
          ImessageChannelRuntime.ImessageChannelRuntime.of({
            pollDue: () =>
              Effect.fail(new ChannelLedger.ChannelLedgerError({ reason, detail: "fence" })),
          }),
        ),
      );
      const harness = makeHarness({ channelsLayer });
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const input = yield* gateway.ingest(
          slackInput("hello", "imsg-fence-" + reason),
          slackContext,
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* ledger.claimOwnership({
          token: runtime.ownerToken,
          now,
          staleBefore: DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, "30 seconds"),
          ),
        });
        const result = yield* Effect.exit(runtime.runPass);
        assert.isTrue(result._tag === "Failure");
        assert.notStrictEqual((yield* ledger.getInput(input.inputId))?.snapshot.state, "replied");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
