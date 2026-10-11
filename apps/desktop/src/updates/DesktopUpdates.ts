import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateInstallPolicy,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DesktopBackendActivity from "./DesktopBackendActivity.ts";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    /** True while a check, download, install, or channel change holds the
        updater's single action reservation. */
    readonly isActionActive: Effect.Effect<boolean>;
    /** True only while an install owns the updater action reservation. */
    readonly isInstallActive: Effect.Effect<boolean>;
    /** Current state plus a stream of every later state change. */
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setInstallPolicy: (
      policy: DesktopUpdateInstallPolicy,
    ) => Effect.Effect<DesktopUpdateState, DesktopAppSettings.DesktopSettingsWriteError>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
      options?: { readonly waitForCheck: boolean },
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const backendActivity = yield* DesktopBackendActivity.DesktopBackendActivity;
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const coordinatorWakeups = yield* Queue.sliding<void>(1);
  const wakeAutomaticUpdateCoordinator = Queue.offer(coordinatorWakeups, undefined).pipe(
    Effect.asVoid,
  );
  const availabilityGeneration = yield* Ref.make(0);
  const attemptedGeneration = yield* Ref.make(-1);
  const automaticInstallAttempt = yield* Ref.make<string | null>(null);

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Makes ref writes + publishes atomic against subscribe, so a snapshot
  // never overlaps with the first change a subscriber receives.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const writeState = (state: DesktopUpdateState, nextState: DesktopUpdateState) =>
    Effect.gen(function* () {
      if (
        (Object.keys(state) as Array<keyof DesktopUpdateState>).every(
          (key) => state[key] === nextState[key],
        )
      )
        return false;
      yield* Ref.set(updateStateRef, nextState);
      yield* PubSub.publish(stateChanges, nextState);
      return true;
    });

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    stateMutex
      .withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(updateStateRef);
          const nextState = f(state);
          const changed = yield* writeState(state, nextState);
          return { state: changed ? nextState : state, changed };
        }),
      )
      .pipe(
        Effect.tap(({ state, changed }) =>
          changed ? electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state) : Effect.void,
        ),
        Effect.map(({ state }) => state),
      );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    updateState(() => state).pipe(Effect.asVoid);

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // The .deb carries electron-builder's resources/package-type marker.
  // electron-updater reads the same file and installs updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished
          ? PubSub.publish(finishedUpdateActions, action).pipe(
              Effect.andThen(wakeAutomaticUpdateCoordinator),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(false);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: false,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      const settings = yield* desktopSettings.get;
      if (
        settings.pendingUpdate &&
        (settings.pendingUpdate.channel !== settings.updateChannel ||
          ((yield* Ref.get(updateStateRef)).downloadedVersion === null &&
            compareSemverVersions(settings.pendingUpdate.version, environment.appVersion) <= 0))
      ) {
        const cleared = yield* desktopSettings.setPendingUpdate(null).pipe(Effect.exit);
        if (Exit.isFailure(cleared)) {
          yield* updateState((current) => ({
            ...current,
            status: "error",
            message: "Could not clear the pending update record. Check again to retry.",
            errorContext: "check",
            canRetry: true,
          }));
          return true;
        }
        yield* updateState((current) => ({
          ...current,
          pendingUpdate: null,
          recoveryStatus: null,
          pendingRestartReason: null,
        }));
      }
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...reduceDesktopUpdateStateOnCheckStart(current, checkedAt),
        recoveryStatus:
          current.pendingUpdate && !current.downloadedVersion && current.installPolicy !== "paused"
            ? "restoring"
            : current.recoveryStatus,
      }));
      yield* logUpdaterInfo("checking for updates", { reason });

      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) => ({
              ...reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
              recoveryStatus:
                current.pendingUpdate && !current.downloadedVersion
                  ? "needs-network"
                  : current.recoveryStatus,
            }));
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  const downloadAvailableUpdate = Effect.fn("desktop.updates.downloadAvailableUpdate")(function* (
    automatic = false,
  ) {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    const admitted = yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(updateStateRef);
        const settings = yield* desktopSettings.get;
        if (
          current.status !== "available" ||
          current.availableVersion !== state.availableVersion ||
          current.channel !== state.channel
        )
          return false;
        if (
          automatic &&
          (settings.updateInstallPolicy === "paused" ||
            current.installPolicy === "paused" ||
            settings.updateChannel !== current.channel ||
            (yield* Ref.get(desktopState.quitting)))
        )
          return false;
        if (automatic) {
          const generation = yield* Ref.get(availabilityGeneration);
          if (generation === (yield* Ref.get(attemptedGeneration))) return false;
          if (!(yield* tryStartUpdateAction("download"))) return false;
        } else if (!(yield* tryStartUpdateAction("download"))) return false;
        yield* Ref.set(attemptedGeneration, yield* Ref.get(availabilityGeneration));
        return true;
      }),
    );
    if (!admitted) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* updateState((current) => reduceDesktopUpdateStateOnDownloadStart(current));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) => ({
              ...reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
              recoveryStatus: null,
            }));
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) => ({
            ...reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            recoveryStatus: null,
          }));
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  });

  // Tells the primary backend that the coming stop is an update restart, so it
  // keeps its managed tunnel for the backend the updated app starts. Best
  // effort: without the marker the backend only re-provisions its tunnel.
  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  // A failed or interrupted install brings no updated backend, so a later
  // quit must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      removeUpdateRestartMarker,
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    yield* Effect.gen(function* () {
      const instances = yield* pool.list;
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const installDownloadedUpdate = (
    expectedVersion?: string,
    automaticAdmission?: Effect.Effect<boolean>,
    waitForCheck = true,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
        let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
        while (admission === "wait-for-check") {
          admission = yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(updateStateRef);
              const activeAction = yield* Ref.get(activeUpdateActionRef);
              const hasExpectedDownload =
                state.downloadedVersion !== null &&
                (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
              if (
                (yield* Ref.get(desktopState.quitting)) ||
                !(yield* Ref.get(updaterConfiguredRef)) ||
                !hasExpectedDownload
              )
                return "refused" as const;
              if (Option.isSome(activeAction)) {
                return waitForCheck &&
                  activeAction.value === "check" &&
                  expectedVersion !== undefined
                  ? ("wait-for-check" as const)
                  : ("refused" as const);
              }
              const hasInstallableDownload =
                state.status === "downloaded" ||
                (state.status === "error" &&
                  (state.errorContext === null || state.errorContext === "install"));
              if (!hasInstallableDownload) return "refused" as const;
              if (automaticAdmission && !(yield* automaticAdmission)) return "refused" as const;
              return (yield* tryStartUpdateAction("install"))
                ? ("admitted" as const)
                : ("refused" as const);
            }),
          );
          if (admission === "wait-for-check") {
            const finishedAction = yield* PubSub.take(actionCompletions).pipe(
              Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
            );
            if (Option.isNone(finishedAction)) admission = "refused";
          }
        }
        if (admission === "refused") return { accepted: false, completed: false, failed: false };

        yield* Ref.set(desktopState.quitting, true);

        return yield* Effect.gen(function* () {
          yield* writeUpdateRestartMarker;
          // Stop every backend in the pool, not just the primary. With
          // parallel WSL + Windows backends, leaving the WSL instance up
          // means quitAndInstall's app.quit() exits before the pool's
          // scope cascade has a chance to run its stop finalizer, so the
          // WSL child gets hard-killed by the OS instead of receiving
          // SIGTERM + grace. Stops run concurrently with the same 5s
          // budget the primary had on its own.
          const instances = yield* pool.list;
          yield* Effect.forEach(
            instances,
            (instance) => instance.stop({ timeout: Duration.seconds(5) }),
            { concurrency: "unbounded" },
          );
          yield* electronUpdater.quitAndInstall({
            isSilent: true,
            isForceRunAfter: true,
          });
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTags({
            ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
              function* (error) {
                yield* recoverFailedInstall(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  channel: error.channel,
                  isSilent: error.isSilent,
                  isForceRunAfter: error.isForceRunAfter,
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
          }),
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              yield* recoverFailedInstall(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
    waitForCheck = true,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const result = yield* installDownloadedUpdate(expectedVersion, undefined, waitForCheck);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  const coordinateAutomaticUpdate = Effect.gen(function* () {
    if (
      !(yield* Ref.get(updaterConfiguredRef)) ||
      (yield* Ref.get(desktopState.quitting)) ||
      Option.isSome(yield* activeUpdateAction)
    )
      return;
    const state = yield* Ref.get(updateStateRef);
    const settings = yield* desktopSettings.get;
    if (settings.updateChannel !== state.channel) return;
    if (state.installPolicy === "paused") {
      if (state.pendingUpdate)
        yield* updateState((current) => ({ ...current, pendingRestartReason: "paused" }));
      return;
    }
    if (state.status === "available" && state.availableVersion) {
      yield* downloadAvailableUpdate(true);
      return;
    }
    if (
      !state.downloadedVersion ||
      !state.pendingUpdate ||
      state.recoveryStatus !== null ||
      state.errorContext === "install"
    )
      return;
    if (state.installPolicy !== "restart-when-idle") return;
    if ((yield* Ref.get(automaticInstallAttempt)) === state.downloadedVersion) return;
    const result = yield* backendActivity.probe;
    yield* updateState((current) =>
      current.installPolicy !== "restart-when-idle"
        ? current
        : {
            ...current,
            pendingRestartReason: result.activity === "idle" ? null : result.activity,
            message: result.reason,
          },
    );
    if (result.activity !== "idle") return;
    const expectedVersion = state.downloadedVersion;
    let admissionProbe: Effect.Success<typeof backendActivity.probe> | null = null;
    const admission = Effect.gen(function* () {
      const fresh = yield* backendActivity.probe;
      admissionProbe = fresh;
      const current = yield* Ref.get(updateStateRef);
      const latestSettings = yield* desktopSettings.get;
      return (
        current.installPolicy === "restart-when-idle" &&
        latestSettings.updateInstallPolicy === "restart-when-idle" &&
        current.channel === state.channel &&
        latestSettings.updateChannel === state.channel &&
        current.downloadedVersion === expectedVersion &&
        current.pendingUpdate?.version === expectedVersion &&
        current.recoveryStatus === null &&
        fresh.activity === "idle" &&
        (yield* fresh.unchanged)
      );
    });
    const installed = yield* installDownloadedUpdate(expectedVersion, admission, false);
    if (installed.accepted) yield* Ref.set(automaticInstallAttempt, expectedVersion);
    else if (admissionProbe) {
      const refusedProbe: Effect.Success<typeof backendActivity.probe> = admissionProbe;
      yield* updateState((current) =>
        current.installPolicy !== "restart-when-idle" ||
        current.downloadedVersion !== expectedVersion
          ? current
          : {
              ...current,
              pendingRestartReason: refusedProbe.activity === "idle" ? null : refusedProbe.activity,
              message: refusedProbe.reason,
            },
      );
    }
  });

  const startAutomaticUpdateCoordinator = Effect.gen(function* () {
    yield* Queue.take(coordinatorWakeups).pipe(
      Effect.andThen(coordinateAutomaticUpdate),
      Effect.catchCause((cause) =>
        logUpdaterError("Automatic update coordination failed.", { cause }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.sleep("60 seconds").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if ((yield* Ref.get(updateStateRef)).pendingUpdate) yield* wakeAutomaticUpdateCoordinator;
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const applyNoUpdate = (checkedAt: string) =>
    stateMutex
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(updateStateRef);
          if (current.downloadedVersion === null && current.pendingUpdate !== null) {
            const cleared = yield* desktopSettings.setPendingUpdate(null).pipe(Effect.exit);
            if (Exit.isFailure(cleared)) {
              yield* writeState(current, {
                ...current,
                status: "error",
                recoveryStatus: null,
                pendingRestartReason: null,
                message: "Could not clear the pending update record. Check again to retry.",
                errorContext: "check",
                canRetry: true,
              });
              return;
            }
          }
          yield* writeState(current, reduceDesktopUpdateStateOnNoUpdate(current, checkedAt));
        }),
      )
      .pipe(Effect.andThen(emitState));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* applyNoUpdate(checkedAt);
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            info.releaseNotes,
            info.version,
            state.channel,
          );
          yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(updateStateRef);
              if (current.channel !== state.channel) return;
              const next = reduceDesktopUpdateStateOnUpdateAvailable(
                current,
                info.version,
                checkedAt,
                releaseNotes,
                omittedReleaseCount,
              );
              yield* Ref.update(availabilityGeneration, (generation) => generation + 1);
              yield* Ref.set(updateStateRef, next);
              yield* PubSub.publish(stateChanges, next);
            }),
          );
          yield* emitState;
          yield* wakeAutomaticUpdateCoordinator;
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    yield* applyNoUpdate(checkedAt);
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      yield* recoverFailedInstall(error.message);
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        recoveryStatus:
          current.pendingUpdate && !current.downloadedVersion
            ? "needs-network"
            : current.recoveryStatus,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const percent = Math.floor(progress.percent);
          yield* updateState((state) =>
            shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null
              ? reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent)
              : state,
          );
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (
            resolveDefaultDesktopUpdateChannel(info.version) !== state.channel ||
            (state.availableVersion !== null && state.availableVersion !== info.version)
          )
            return;
          const pendingUpdate = {
            version: info.version,
            channel: state.channel,
            downloadedAt: yield* currentIsoTimestamp,
          };
          const persisted = yield* desktopSettings
            .setPendingUpdate(pendingUpdate)
            .pipe(Effect.exit);
          if (Exit.isSuccess(persisted) && persisted.value.settings.pendingUpdate !== pendingUpdate)
            return;
          if (Exit.isFailure(persisted)) {
            yield* updateState((current) => ({
              ...current,
              status: "available",
              downloadedVersion: null,
              message: "Could not persist the downloaded update. Retry the download.",
              errorContext: "download",
              canRetry: true,
            }));
            return;
          }
          yield* updateState((current) =>
            current.channel !== pendingUpdate.channel
              ? current
              : {
                  ...reduceDesktopUpdateStateOnDownloadComplete(current, info.version),
                  pendingUpdate,
                  recoveryStatus: null,
                  pendingRestartReason: current.installPolicy === "paused" ? "paused" : null,
                },
          );
          yield* Ref.set(automaticInstallAttempt, null);
          yield* wakeAutomaticUpdateCoordinator;
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      let settings = yield* desktopSettings.get;
      let pendingPersistenceFailed = false;
      // Startup recovery intentionally drops lower/equal versions, including a
      // previously downloaded downgrade. Only an explicit channel switch in
      // this session can authorize a downgrade; polling preserves its installer.
      if (
        settings.pendingUpdate &&
        (settings.pendingUpdate.channel !== settings.updateChannel ||
          compareSemverVersions(settings.pendingUpdate.version, environment.appVersion) <= 0)
      ) {
        const cleared = yield* desktopSettings.setPendingUpdate(null).pipe(Effect.exit);
        if (Exit.isSuccess(cleared)) settings = cleared.value.settings;
        else pendingPersistenceFailed = true;
      }
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState({
        ...createBaseUpdateState(settings.updateChannel, enabled, environment),
        installPolicy: settings.updateInstallPolicy,
        pendingUpdate: settings.pendingUpdate,
        pendingRestartReason:
          settings.pendingUpdate && settings.updateInstallPolicy === "paused" ? "paused" : null,
        recoveryStatus:
          enabled && settings.pendingUpdate && settings.updateInstallPolicy !== "paused"
            ? "restoring"
            : null,
        ...(enabled && pendingPersistenceFailed
          ? ({
              status: "error",
              message: "Could not clear the pending update record. Check again to retry.",
              errorContext: "check",
              canRetry: true,
            } as const)
          : {}),
      });
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* startAutomaticUpdateCoordinator;

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setInstallPolicy: Effect.fn("desktop.updates.setInstallPolicy")(function* (policy) {
      yield* desktopSettings.setUpdateInstallPolicy(policy);
      const state = yield* updateState((current) => ({
        ...current,
        installPolicy: policy,
        pendingRestartReason: policy === "paused" && current.pendingUpdate ? "paused" : null,
        recoveryStatus:
          current.enabled && current.pendingUpdate && !current.downloadedVersion
            ? policy === "paused"
              ? null
              : "restoring"
            : current.recoveryStatus,
      }));
      yield* wakeAutomaticUpdateCoordinator;
      if (
        policy !== "paused" &&
        state.pendingUpdate &&
        !state.downloadedVersion &&
        state.status !== "available"
      )
        yield* checkForUpdates("policy-resume");
      return yield* Ref.get(updateStateRef);
    }),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (nextChannel === state.channel) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        const settings = yield* desktopSettings.get;
        const enabled = yield* shouldEnableAutoUpdates;
        yield* setState({
          ...createBaseUpdateState(nextChannel, enabled, environment),
          installPolicy: settings.updateInstallPolicy,
        });

        if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        yield* electronUpdater.setAllowDowngrade(true);
        yield* checkForUpdates("channel-change", "held").pipe(
          Effect.ensuring(electronUpdater.setAllowDowngrade(false).pipe(Effect.ignore)),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate();
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: (expectedVersion, options) =>
      installWithExpectedVersion(expectedVersion, options?.waitForCheck ?? true),
  });
});

export const layer = Layer.effect(DesktopUpdates, make).pipe(
  Layer.provide(DesktopBackendActivity.layer),
);
