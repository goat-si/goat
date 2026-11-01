/**
 * Minimal Rescheduler layer for tests that run goals on this machine only: rescheduling is refused.
 * The server provides the real one from fleet/health/layer.ts.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Rescheduler } from "./health/Rescheduler.ts";
export const layerRescheduler = Layer.succeed(
  Rescheduler,
  Rescheduler.of({
    reschedule: () =>
      Effect.succeed({
        _tag: "Refused",
        reason: "unsupported_remote",
        message: "This layer does not reschedule.",
      }),
    findMove: () => Effect.succeed({ _tag: "NotLaunched" }),
  }),
);
