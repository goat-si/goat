import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { retryDelayMs } from "../retryJitter.ts";

const GRACE_MS = 10 * 60_000;
const RETRIES = 6;

/**
 * A host that just came back can refuse a report read while its GOAT server is still starting,
 * though the remote thread is fine. A refusal within ten minutes of an outage is retried a few
 * times before the dispatch is given up as lost; a requested delete still wins.
 */
export const makeRefusalGrace = <E, R>(deleteHeld: Effect.Effect<boolean, E, R>) => {
  let outageAt: number | null = null;
  let retries = 0;
  return {
    outage: Effect.map(Clock.currentTimeMillis, (now) => void (outageAt = now)),
    retry: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (outageAt === null || now - outageAt >= GRACE_MS || retries >= RETRIES) return false;
      if (yield* deleteHeld) return false;
      retries += 1;
      yield* Effect.sleep(yield* retryDelayMs(5_000 * 2 ** (retries - 1)));
      return true;
    }),
  };
};
