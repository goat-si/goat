import { assert, describe, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  ChannelInputId,
  ChannelConversationId,
  type ChannelOutboundMessage,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { bindingIdFor, deliveryIdFor } from "./channelIds.ts";

const owner = "deadline-owner";
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const receipt = Effect.fn("ReceiptDeliveryTest.receipt")(function* (key: string) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const now = yield* nowIso;
  yield* ledger.claimOwnership({ token: owner, now, staleBefore: now });
  const inputId = ChannelInputId.make("input:" + key);
  const conversationId = ChannelConversationId.make("conversation:" + key);
  const destination = {
    kind: "slack" as const,
    connectionId: "slack",
    teamId: "T",
    channelId: "C",
    rootTs: key,
  };
  yield* ledger.acceptInput({
    ownerId: "owner",
    inputId,
    conversationId,
    bindingId: bindingIdFor(conversationId, "root"),
    contentHash: key,
    acceptedAt: now,
    requester: {
      ownerId: "owner",
      principalId: "owner",
      displayName: "Person",
      originKind: "slack",
      runtimeModeCeiling: "full-access",
      grantedScopes: ["orchestration:operate"],
    },
    message: {
      kind: "slack",
      connectionId: "slack",
      conversationKey: key,
      externalMessageId: key,
      idempotencyKey: key,
      actor: { externalActorId: "U" },
      replyAddress: destination,
      text: "Inspect disk",
      attachments: [],
      receivedAt: now,
      intent: "message",
    },
  });
  const causeKey = "reply:" + inputId;
  const deliveryId = deliveryIdFor(causeKey);
  yield* ledger.enqueueDeliveries(
    [
      {
        causeKey,
        deliveryId,
        inputId,
        message: {
          deliveryId,
          destination,
          kind: "receipt",
          text: "Checking.",
          inReplyToInputId: inputId,
        },
      },
    ],
    now,
  );
  return deliveryId;
});

const layer = (
  send: (
    message: ChannelOutboundMessage,
  ) => Effect.Effect<
    { deliveryId: ChannelOutboundMessage["deliveryId"]; acceptedAt: string },
    ChannelGatewayError
  >,
  wake: Layer.Layer<ChannelWake.ChannelWake> = ChannelWake.layer,
) =>
  ChannelDeliveryWorker.layer.pipe(
    Layer.provide(Layer.mock(ChannelGateway.ChannelGateway)({ send })),
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provide(wake),
    Layer.provideMerge(Sqlite.layerMemory),
  );

const notSent = (retryAfterSeconds: number, rateLimited = false) =>
  new ChannelGatewayError({
    reason: "delivery_failed",
    deliveryOutcome: "not_sent",
    ...(rateLimited ? { deliveryErrorCode: "rate_limited" as const } : {}),
    retryAfterSeconds,
  });

/** A wake signal that only counts, so a test can see when the channel loop would run. */
const countingWake = (count: () => void) =>
  Layer.succeed(ChannelWake.ChannelWake)({ wake: Effect.sync(count), next: Effect.never });

describe("absolute receipt delivery deadlines", () => {
  it.effect("a settled receipt wakes the channel loop to send the rows it held back", () => {
    let wakes = 0;
    return Effect.gen(function* () {
      const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
      yield* receipt("wake");
      yield* worker.deliverReceipts(owner);
      yield* worker.settleReceipts;
      assert.strictEqual(wakes, 1);
    }).pipe(
      Effect.provide(
        layer(
          (message) =>
            Effect.succeed({
              deliveryId: message.deliveryId,
              acceptedAt: "1970-01-01T00:00:00.000Z",
            }),
          countingWake(() => {
            wakes += 1;
          }),
        ),
      ),
    );
  });
  it.effect(
    "a retry left pending by an earlier process wakes the loop when its deadline expires it",
    () => {
      let wakes = 0;
      return Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const id = yield* receipt("restart-retry");
        const [claimed] = yield* ledger.claimDueDeliveries({ owner, now: yield* nowIso, limit: 1 });
        const later = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 2 }));
        yield* ledger.recordDelivery({
          owner,
          deliveryId: id,
          attempt: claimed!.attempts,
          now: yield* nowIso,
          outcome: { type: "retry", at: later, errorCode: "rate_limited" },
        });
        assert.strictEqual(wakes, 0);
        // No worker timer survives a restart; the runtime's deadline scan expires the row instead.
        yield* TestClock.adjust("60 seconds");
        yield* ledger.expireReceipts({ owner, now: yield* nowIso });
        assert.strictEqual(yield* ledger.getDeliveryState(id), "failed");
        assert.strictEqual(wakes, 1);
        yield* ledger.expireReceipts({ owner, now: yield* nowIso });
        assert.strictEqual(wakes, 1);
      }).pipe(
        Effect.provide(
          layer(
            () => Effect.die("unused"),
            countingWake(() => {
              wakes += 1;
            }),
          ),
        ),
      );
    },
  );
  it.effect("an older attempt cannot reset a receipt claimed by a newer attempt", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const id = yield* receipt("attempt-fence");
      const [first] = yield* ledger.claimDueDeliveries({ owner, now: yield* nowIso, limit: 1 });
      assert.isDefined(first);
      yield* ledger.recordDelivery({
        owner,
        deliveryId: id,
        attempt: first!.attempts,
        now: yield* nowIso,
        outcome: { type: "retry", at: yield* nowIso, errorCode: "retry" },
      });
      const [second] = yield* ledger.claimDueDeliveries({ owner, now: yield* nowIso, limit: 1 });
      assert.isDefined(second);
      yield* ledger.recordDelivery({
        owner,
        deliveryId: id,
        attempt: first!.attempts,
        now: yield* nowIso,
        outcome: { type: "retry", at: yield* nowIso, errorCode: "late" },
      });
      assert.strictEqual(yield* ledger.getDeliveryState(id), "delivering");
      yield* ledger.recordDelivery({
        owner,
        deliveryId: id,
        attempt: second!.attempts,
        now: yield* nowIso,
        outcome: { type: "delivered" },
      });
      assert.strictEqual(yield* ledger.getDeliveryState(id), "delivered");
    }).pipe(
      Effect.provide(
        layer((message) =>
          Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "1970-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ),
  );
  it.effect("starts another receipt while eight receipt transports are hung", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const sent: string[] = [];
      yield* Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        for (let index = 0; index < 8; index += 1) yield* receipt("hung-" + index);
        const last = yield* receipt("last");
        yield* Effect.forkChild(worker.deliverDue(owner));
        yield* Deferred.await(firstEntered);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(sent, 9);
        assert.strictEqual(yield* ledger.getDeliveryState(last), "delivered");
      }).pipe(
        Effect.provide(
          layer((message) => {
            const key = message.destination.kind === "slack" ? message.destination.rootTs : "";
            sent.push(key);
            return key === "last"
              ? Effect.succeed({
                  deliveryId: message.deliveryId,
                  acceptedAt: "1970-01-01T00:00:00.000Z",
                })
              : Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Effect.never));
          }),
        ),
      );
    }),
  );

  it.effect.each([false, true])(
    "expires definitely-unsent receipts at 60 seconds and wakes the loop (rate-limited=%s)",
    (rateLimited) => {
      let sends = 0;
      let wakes = 0;
      return Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        const id = yield* receipt("retry");
        yield* worker.deliverDue(owner);
        assert.strictEqual(wakes, 0);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(yield* ledger.getDeliveryState(id), "failed");
        assert.strictEqual(wakes, 1);
        yield* worker.deliverDue(owner);
        assert.strictEqual(yield* ledger.getDeliveryState(id), "failed");
        assert.strictEqual(sends, 1);
      }).pipe(
        Effect.provide(
          layer(
            () => {
              sends += 1;
              return Effect.fail(notSent(120, rateLimited));
            },
            countingWake(() => {
              wakes += 1;
            }),
          ),
        ),
      );
    },
  );

  it.effect("settles a hung send after four seconds without waiting for transport cleanup", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        const id = yield* receipt("hung");
        yield* Effect.forkChild(worker.deliverDue(owner));
        yield* Deferred.await(entered);
        yield* TestClock.adjust("4 seconds");
        assert.strictEqual(yield* ledger.getDeliveryState(id), "ambiguous");
        yield* Deferred.succeed(cleanup, undefined);
      }).pipe(
        Effect.ensuring(Deferred.succeed(cleanup, undefined)),
        Effect.provide(
          layer(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.await(cleanup)),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("caps a retry started at 59 seconds at the absolute 60 second deadline", () =>
    Effect.gen(function* () {
      const retryEntered = yield* Deferred.make<void>();
      let attempts = 0;
      yield* Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        const id = yield* receipt("near-deadline");
        yield* TestClock.adjust("55 seconds");
        yield* worker.deliverDue(owner);
        yield* TestClock.adjust("4 seconds");
        yield* Effect.forkChild(worker.deliverDue(owner));
        yield* Deferred.await(retryEntered);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* ledger.getDeliveryState(id), "ambiguous");
        assert.strictEqual(attempts, 2);
      }).pipe(
        Effect.provide(
          layer(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(notSent(4, true))
              : Deferred.succeed(retryEntered, undefined).pipe(Effect.andThen(Effect.never));
          }),
        ),
      );
    }),
  );

  it.effect("does not start a send at or after accepted_at plus 60 seconds", () => {
    let sends = 0;
    return Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
      const id = yield* receipt("expired-before-send");
      yield* TestClock.adjust("60 seconds");
      yield* worker.deliverDue(owner);
      assert.strictEqual(sends, 0);
      assert.strictEqual(yield* ledger.getDeliveryState(id), "failed");
    }).pipe(
      Effect.provide(
        layer((message) => {
          sends += 1;
          return Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "1970-01-01T00:01:00.000Z",
          });
        }),
      ),
    );
  });
});
