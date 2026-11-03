import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CuaDriverError } from "./CuaDriver.ts";

export const desktopStopAcknowledged = Effect.fn("CuaDriver.desktopStopAcknowledged")(function* (
  stopped: Deferred.Deferred<void, CuaDriverError>,
) {
  const outcome = yield* Deferred.await(stopped).pipe(
    Effect.result,
    Effect.timeoutOption("3 seconds"),
  );
  return (
    Option.isSome(outcome) &&
    outcome.value._tag === "Failure" &&
    outcome.value.failure._tag === "CuaDriverHostError" &&
    outcome.value.failure.operation === "restart"
  );
});
