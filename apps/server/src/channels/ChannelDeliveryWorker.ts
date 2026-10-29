/**
 * ChannelDeliveryWorker - hands committed outbox rows to their transports.
 *
 * Delivery is at least once and keeps its delivery id across retries. A transport says whether
 * a failed send certainly did not arrive (`not_sent`, retried, after Retry-After for rate limits)
 * or may have (`unknown`, recorded as ambiguous and not repeated). Account and channel errors that
 * a retry cannot fix fail the row. Each row is claimed right before its send, so a restart finds at
 * most the one row that was really in flight. Rows go oldest first, and a task's later row waits for
 * its earlier ones, so a receipt goes out before its result.
 *
 * @module ChannelDeliveryWorker
 */
import type { ChannelGatewayError } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";

/** With exponential backoff capped at five minutes, ten attempts span about thirteen minutes. */
const MAX_ATTEMPTS = 10;
/** Rows one pass may send before it yields to the rest of the loop. */
const MAX_PER_PASS = 50;
const NON_RETRYABLE = new Set([
  "not_in_channel",
  "channel_not_found",
  "invalid_auth",
  "token_revoked",
]);

/** What to record for a failed send. */
export const deliveryOutcomeFor = (
  error: ChannelGatewayError,
  attempts: number,
  now: DateTime.Utc,
): ChannelLedger.ChannelDeliveryOutcome => {
  const code = error.deliveryErrorCode ?? error.reason;
  if (error.reason === "adapter_unavailable") return { type: "failed", errorCode: code };
  if (error.deliveryOutcome === "unknown") return { type: "ambiguous", errorCode: code };
  if (error.deliveryErrorCode !== undefined && NON_RETRYABLE.has(error.deliveryErrorCode)) {
    return { type: "failed", errorCode: code };
  }
  if (attempts >= MAX_ATTEMPTS) return { type: "failed", errorCode: code };
  const waitSeconds = error.retryAfterSeconds ?? Math.min(2 ** attempts, 300);
  return {
    type: "retry",
    at: DateTime.formatIso(DateTime.addDuration(now, Duration.seconds(waitSeconds))),
    errorCode: code,
  };
};

export class ChannelDeliveryWorker extends Context.Service<
  ChannelDeliveryWorker,
  {
    /** Sends every due row once. Returns how many rows it handled. */
    readonly deliverDue: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    readonly deliverReceipts: (
      owner: string,
    ) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    readonly settleReceipts: Effect.Effect<void>;
  }
>()("goat/channels/ChannelDeliveryWorker") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const scope = yield* Effect.scope;
  const receipts = new Set<Fiber.Fiber<void, unknown>>();

  const sendReceipt = Effect.fn("ChannelDeliveryWorker.sendReceipt")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    owner: string,
  ) {
    const clock = yield* DateTime.now;
    const remaining =
      (delivery.receiptDeadline ?? DateTime.toEpochMillis(clock)) - DateTime.toEpochMillis(clock);
    if (remaining <= 0) {
      yield* ledger.expireReceipts({ owner, now: DateTime.formatIso(clock) });
      return;
    }
    const expiry = yield* Effect.sleep(remaining).pipe(
      Effect.andThen(
        Effect.flatMap(DateTime.now, (now) =>
          ledger.expireReceipts({ owner, now: DateTime.formatIso(now) }),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    const send = yield* gateway.send(delivery.message).pipe(Effect.forkIn(scope));
    const result = yield* Fiber.join(send).pipe(
      Effect.result,
      Effect.timeoutOption(Duration.millis(Math.min(4_000, remaining))),
    );
    const now = yield* DateTime.now;
    const outcome: ChannelLedger.ChannelDeliveryOutcome = Option.isNone(result)
      ? { type: "ambiguous", errorCode: "receipt_timeout" }
      : result.value._tag === "Success"
        ? { type: "delivered", externalMessageId: result.value.success.externalMessageId }
        : deliveryOutcomeFor(result.value.failure, delivery.attempts, now);
    yield* ledger.recordDelivery({
      owner,
      deliveryId: delivery.deliveryId,
      attempt: delivery.attempts,
      now: DateTime.formatIso(now),
      outcome,
    });
    if (outcome.type !== "retry") yield* Fiber.interrupt(expiry).pipe(Effect.forkIn(scope));
    if (Option.isNone(result)) yield* Fiber.interrupt(send).pipe(Effect.forkIn(scope));
  });

  const deliverReceipts = Effect.fn("ChannelDeliveryWorker.deliverReceipts")(function* (
    owner: string,
  ) {
    let handled = 0;
    for (;;) {
      const [row] = yield* ledger.claimDueDeliveries({
        owner,
        now: DateTime.formatIso(yield* DateTime.now),
        limit: 1,
        receiptsOnly: true,
      });
      if (row === undefined) break;
      let fiber: Fiber.Fiber<void, unknown> | undefined;
      fiber = yield* sendReceipt(row, owner).pipe(
        Effect.tapCause((cause) => Effect.logWarning("channel receipt send failed", { cause })),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (fiber !== undefined) receipts.delete(fiber);
          }),
        ),
        Effect.forkIn(scope),
      );
      receipts.add(fiber);
      handled += 1;
    }
    return handled;
  });

  const deliverDue = Effect.fn("ChannelDeliveryWorker.deliverDue")(function* (owner: string) {
    let handled = yield* deliverReceipts(owner);
    while (handled < MAX_PER_PASS) {
      const [delivery] = yield* ledger.claimDueDeliveries({
        owner,
        now: DateTime.formatIso(yield* DateTime.now),
        limit: 1,
        receiptsOnly: false,
      });
      if (delivery === undefined) break;
      const sent = yield* gateway.send(delivery.message).pipe(Effect.result);
      const finishedAt = yield* DateTime.now;
      yield* ledger.recordDelivery({
        owner,
        deliveryId: delivery.deliveryId,
        attempt: delivery.attempts,
        outcome:
          sent._tag === "Success"
            ? {
                type: "delivered",
                ...(sent.success.externalMessageId === undefined
                  ? {}
                  : { externalMessageId: sent.success.externalMessageId }),
              }
            : deliveryOutcomeFor(sent.failure, delivery.attempts, finishedAt),
        now: DateTime.formatIso(finishedAt),
      });
      handled += 1;
    }
    return handled;
  });

  const settleReceipts = Effect.suspend(() =>
    Effect.forEach([...receipts], (fiber) => Fiber.await(fiber), { discard: true }),
  );
  return ChannelDeliveryWorker.of({ deliverDue, deliverReceipts, settleReceipts });
});

export const layer = Layer.effect(ChannelDeliveryWorker, make);
