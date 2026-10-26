import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";

import { addIdleDeadline, type TimedRequest } from "./electronRequestTimeout.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@goat/desktop/electron/ElectronUpdater") {}

interface UpdaterHttpExecutor {
  addTimeOutHandler: (request: TimedRequest, fail: (error: Error) => void, timeout: number) => void;
}

// electron-updater builds its HTTP executor with the updater and routes every feed request
// and download through addTimeOutHandler, whose socket-based deadline never fires under
// Electron (see addIdleDeadline). Without a working deadline one stalled request is
// shared by every later check until the app restarts.
function installRequestDeadlines(updater: AutoUpdater): void {
  const executor = (updater as unknown as { httpExecutor: UpdaterHttpExecutor | null })
    .httpExecutor;
  if (executor === null) return;
  executor.addTimeOutHandler = (request, fail, timeout) => addIdleDeadline(request, fail, timeout);
}

// Reading autoUpdater constructs the platform updater, which throws for a non-semver app
// version; an unpackaged Linux dev build reports "0.0" (#1543). Only touch it once updates
// are configured, which DesktopUpdates skips while updates are disabled.
let deadlinesInstalled = false;
function updater(): AutoUpdater {
  if (!deadlinesInstalled) {
    installRequestDeadlines(autoUpdater);
    deadlinesInstalled = true;
  }
  return autoUpdater;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (options) =>
    Effect.suspend(() => {
      updater().setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      updater().autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      updater().autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      updater().channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      updater().allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => updater().allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      updater().allowDowngrade = value;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      updater().fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      updater().disableDifferentialDownload = value;
      return Effect.void;
    }),
  checkForUpdates: Effect.suspend(() => {
    const channel = updater().channel;
    return Effect.tryPromise({
      try: () => updater().checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = updater().channel;
    return Effect.tryPromise({
      try: () => updater().downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.suspend(() => {
      const channel = updater().channel;
      return Effect.try({
        try: () => updater().quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
  on: (eventName, listener) => {
    const eventTarget = updater() as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
