import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export const REQUEST_REPLY_TIMEOUT = "10 seconds";
export const deliver = <E>(answer: Effect.Effect<void, E>) =>
  answer.pipe(
    Effect.retry({ times: 1 }),
    Effect.timeout(REQUEST_REPLY_TIMEOUT),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );
