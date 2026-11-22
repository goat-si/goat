import type { DesktopUpdateActionResult, DesktopUpdateState } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const downloadWithNetworkRetry = Effect.fn("desktop.updates.downloadWithNetworkRetry")(
  function* (download: (retryOf?: DesktopUpdateState) => Effect.Effect<DesktopUpdateActionResult>) {
    let attempt = yield* download();
    for (const delay of ["2 seconds", "8 seconds"] as const) {
      const failed = attempt.state;
      if (
        !attempt.accepted ||
        failed.errorContext !== "download" ||
        !/\b(?:ERR_HTTP2_PROTOCOL_ERROR|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ECONNRESET|ETIMEDOUT)\b/u.test(
          failed.message ?? "",
        )
      )
        break;
      // Release the download reservation during backoff. A manual action, channel
      // change or fresh offer replaces this snapshot and invalidates the retry.
      yield* Effect.sleep(delay);
      attempt = yield* download(failed);
    }
  },
);
