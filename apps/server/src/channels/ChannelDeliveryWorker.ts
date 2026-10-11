/**
 * ChannelDeliveryWorker - hands committed outbox rows to their transports.
 *
 * Delivery is at least once and keeps its delivery id across retries. A transport says whether
 * a failed send certainly did not arrive (`not_sent`, retried, after Retry-After for rate limits)
 * or may have (`unknown`, recorded as ambiguous and not repeated). Account and channel errors that
 * a retry cannot fix fail the row. Rows are claimed oldest first, so a task's receipt goes out
 * before its result.
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

const MAX_ATTEMPTS = 6;
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
      const now = yield* DateTime.now;
      const due = yield* ledger.claimDueDeliveries({
        owner,
        now: DateTime.formatIso(now),
        limit: 50,
      });
      for (const delivery of due) {
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
      }
      return due.length;
    });

  return ChannelDeliveryWorker.of({ deliverDue });
});

export const layer = Layer.effect(ChannelDeliveryWorker, make);
