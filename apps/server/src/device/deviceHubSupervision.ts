import * as Effect from "effect/Effect";
import { supervise } from "../backgroundSupervision.ts";

export const retryHubReplacement = Effect.fn("LocalDeviceHost.retryHubReplacement")(function* <
  E,
  R,
>(attempt: Effect.Effect<unknown, E, R>) {
  yield* supervise("LocalDeviceHost.replaceHub", () => attempt, { restartOnSuccess: false });
});
