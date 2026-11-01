import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { ApnsDeliveries } from "./ApnsDeliveries.ts";
import { isApnsDeliveryJobVerificationError } from "./apnsDeliveryJobs.ts";

export const processMessage = Effect.fn("relay.apns_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* ApnsDeliveries;
  yield* deliveries.processSignedJob(message.body).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => message.ack()),
      onFailure: Effect.fnUntraced(function* (error) {
        if (isApnsDeliveryJobVerificationError(error)) {
          message.ack();
          yield* Effect.logInfo("Dropping invalid or legacy APNs job", { errorTag: error._tag });
          return;
        }
        message.retry();
        yield* Effect.logWarning("APNs queue delivery failed; retrying message", {
          errorTag: error._tag,
        });
      }),
    }),
  );
});
