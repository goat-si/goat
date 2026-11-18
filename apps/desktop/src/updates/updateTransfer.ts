import type { DesktopUpdateChannel, DesktopUpdateState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { DesktopUpdateCheckTimeoutError, UPDATE_CHECK_TIMEOUT } from "./updateFailures.ts";

export const checkDesktopUpdateFeed = (
  updater: ElectronUpdater.ElectronUpdater["Service"],
  channel: DesktopUpdateChannel,
) =>
  updater.checkForUpdates.pipe(
    Effect.timeoutOrElse({
      duration: UPDATE_CHECK_TIMEOUT,
      orElse: () => Effect.fail(new DesktopUpdateCheckTimeoutError({ channel })),
    }),
  );

type FeedOffer = { readonly info: unknown } | "unavailable";

export function makeUpdateFeedCapture() {
  let receive: ((offer: FeedOffer) => void) | undefined;
  return {
    capture(offer: FeedOffer): boolean {
      if (receive === undefined) return false;
      receive(offer);
      return true;
    },
    // Electron can emit before resolving the check promise. Apply its result under the reservation.
    during: <E>(check: Effect.Effect<void, E>) =>
      Effect.suspend(() => {
        let captured: FeedOffer | undefined;
        receive = (offer) => {
          captured = offer;
        };
        return check.pipe(
          Effect.map(() => captured),
          Effect.ensuring(
            Effect.sync(() => {
              receive = undefined;
            }),
          ),
        );
      }),
  };
}

export const hasDownloadOffer = (state: DesktopUpdateState) =>
  state.availableVersion !== null &&
  (state.status === "available" ||
    (state.status === "error" && state.errorContext === "download" && state.canRetry));

export const isPersistedDownload = (
  state: DesktopUpdateState,
  channel: DesktopUpdateChannel,
  version: string,
) =>
  state.channel === channel &&
  state.downloadedVersion === version &&
  state.pendingUpdate?.version === version &&
  state.pendingUpdate.channel === channel;

export function waitForPersistedDownload(
  channel: DesktopUpdateChannel,
  version: string,
  latest: DesktopUpdateState,
  changes: Stream.Stream<DesktopUpdateState>,
) {
  return Stream.concat(Stream.make(latest), changes).pipe(
    Stream.filter(
      (state) =>
        isPersistedDownload(state, channel, version) ||
        !state.enabled ||
        state.channel !== channel ||
        (state.availableVersion === version && state.errorContext === "download"),
    ),
    Stream.runHead,
    Effect.timeoutOption("90 seconds"),
    Effect.map((result) => Option.flatten(result)),
  );
}
