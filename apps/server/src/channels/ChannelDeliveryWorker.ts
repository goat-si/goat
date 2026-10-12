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
import type { ChannelGatewayError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  }
>()("t3/channels/ChannelDeliveryWorker") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const gateway = yield* ChannelGateway.ChannelGateway;

  const deliverDue: ChannelDeliveryWorker["Service"]["deliverDue"] = (owner) =>
    Effect.gen(function* () {
      let handled = 0;
      while (handled < MAX_PER_PASS) {
        const [delivery] = yield* ledger.claimDueDeliveries({
          owner,
          now: DateTime.formatIso(yield* DateTime.now),
          limit: 1,
        });
        if (delivery === undefined) break;
        const sent = yield* gateway.send(delivery.message).pipe(Effect.result);
        const finishedAt = yield* DateTime.now;
        yield* ledger.recordDelivery({
          owner,
          deliveryId: delivery.deliveryId,
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

  return ChannelDeliveryWorker.of({ deliverDue });
});

export const layer = Layer.effect(ChannelDeliveryWorker, make);
