import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcSchema from "effect/rpc/RpcSchema";

/**
 * Unary requests one WebSocket connection may have running at once. Streams stay open for the
 * life of a view, so they are exempt; message size limits are separate.
 */
const MAX_IN_FLIGHT_RPC_REQUESTS = 256;

/**
 * Ends one over-limit request as a defect: every RPC's error schema is shared with clients, so a
 * typed failure would need a contract change. disableFatalDefects keeps the socket and other calls.
 */
class RpcRequestLimitError extends Data.TaggedError("RpcRequestLimitError")<{
  readonly message: string;
  readonly limit: number;
}> {}

/** One counter per connection: the middleware layer is built once per socket. */
export const makeInFlightLimit = (limit: number = MAX_IN_FLIGHT_RPC_REQUESTS) => {
  let inFlight = 0;
  const admit = Effect.suspend(() => {
    if (inFlight >= limit) {
      return Effect.die(
        new RpcRequestLimitError({
          message: `This connection already has ${limit} requests in flight.`,
          limit,
        }),
      );
    }
    inFlight += 1;
    return Effect.void;
  });
  const release = Effect.sync(() => {
    inFlight -= 1;
  });
  return <A, E, R>(rpc: Rpc.AnyWithProps, effect: Effect.Effect<A, E, R>) =>
    RpcSchema.isStreamSchema(rpc.successSchema)
      ? effect
      : Effect.acquireUseRelease(
          admit,
          () => effect,
          () => release,
        );
};
