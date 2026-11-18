import type { DesktopUpdateChannel, DesktopUpdateState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { DesktopUpdateCheckTimeoutError, UPDATE_CHECK_TIMEOUT } from "./updateFailures.ts";

export const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(
  Schema.Struct({ percent: Schema.Number }),
);

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

export const hasInstallableDownload = (state: DesktopUpdateState) =>
  state.status === "downloaded" ||
  (state.status === "error" && (state.errorContext === null || state.errorContext === "install"));

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

type DownloadAttempt = {
  readonly channel: DesktopUpdateChannel;
  readonly version: string;
  claimed: boolean;
};

export function makeUpdateDownloadAttempts() {
  let current: DownloadAttempt | null = null;
  let started = false;
  return {
    start(channel: DesktopUpdateChannel, version: string) {
      started = true;
      current = { channel, version, claimed: false };
      return current;
    },
    finish(attempt: DownloadAttempt) {
      if (current === attempt) current = null;
    },
    capture: () => current,
    claim(attempt: DownloadAttempt | null, channel: DesktopUpdateChannel, version: string) {
      if (attempt === null) return !started;
      if (
        current !== attempt ||
        attempt.claimed ||
        attempt.channel !== channel ||
        attempt.version !== version
      )
        return false;
      attempt.claimed = true;
      return true;
    },
    isCurrent: (attempt: DownloadAttempt | null) =>
      attempt === null ? !started : current === attempt,
  };
}

export const persistUpdateDownload = Effect.fn("desktop.updates.persistDownload")(function* (
  settings: DesktopAppSettings.DesktopAppSettings["Service"],
  record: NonNullable<DesktopUpdateState["pendingUpdate"]>,
  isCurrent: () => boolean,
  publish: (saved: boolean) => Effect.Effect<boolean>,
) {
  if (!isCurrent()) return false;
  const saved = yield* settings.setPendingUpdate(record, isCurrent).pipe(Effect.exit);
  if (Exit.isFailure(saved)) return yield* publish(false);
  if (saved.value.settings.pendingUpdate !== record) return false;
  if (yield* publish(true)) return true;
  yield* settings
    .setPendingUpdate(null, (current) => current === record)
    .pipe(Effect.ignore({ log: true }));
  return false;
});
