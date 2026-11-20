import * as Effect from "effect/Effect";
import { PUBLISHED_BACKGROUND_MAX_BYTES } from "@goat/contracts/themeRpc";
export { PUBLISHED_BACKGROUND_MAX_BYTES };
const PUBLISHED_BACKGROUND_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT_BACKGROUNDS = 64;

export function makePublishedBackgroundBudget() {
  let bytes = 0;
  let requests = 0;
  const reserve = (size: number) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          size > PUBLISHED_BACKGROUND_MAX_BYTES ||
          bytes + size > PUBLISHED_BACKGROUND_IN_FLIGHT_BYTES ||
          requests >= MAX_IN_FLIGHT_BACKGROUNDS
        )
          return null;
        bytes += size;
        requests++;
        return { size };
      }),
      (lease) =>
        Effect.sync(() => {
          if (lease === null) return;
          bytes -= lease.size;
          requests--;
        }),
    );
  return { reserve, inFlightBytes: () => bytes };
}

export const publishedBackgroundBudget = makePublishedBackgroundBudget();
