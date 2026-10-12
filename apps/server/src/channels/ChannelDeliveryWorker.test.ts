import { assert, describe, it } from "@effect/vitest";
import { ChannelOutboundMessage, type ChannelTaskId } from "@goat/contracts";
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
import { deliveryIdFor } from "./channelIds.ts";

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
