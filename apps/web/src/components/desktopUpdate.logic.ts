import { gtFallback, type useGT } from "gt-react";
import type { DesktopBridge, DesktopUpdateActionResult, DesktopUpdateState } from "@goat/contracts";
import { CLI_RELEASE_REPOSITORY, cliReleaseChannelOf } from "@goat/shared/cliRelease";

export type DesktopUpdateTranslate = ReturnType<typeof useGT>;

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : CLI_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.GOAT_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.GOAT_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(
  state: DesktopUpdateState,
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return gt("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return gt(
      "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return gt(
      "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return gt(
    "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  if (!state.enabled)
    return (
      translateDesktopUpdateMessage(state.message, gt) ?? gt("Automatic updates are disabled.")
    );
  const actionTooltip = getDesktopUpdateActionTooltip(state, gt);
  const installationNotice = state.installationNotice
    ? translateDesktopUpdateMessage(state.installationNotice, gt)
    : null;
  return installationNotice ? `${actionTooltip}\n${installationNotice}` : actionTooltip;
}

function getDesktopUpdateActionTooltip(
  state: DesktopUpdateState,
  gt: DesktopUpdateTranslate,
): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return gt("Update {version} did not apply. Click to retry.", {
      version: state.notAppliedVersion,
    });
  }
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return gt("Download failed for {version}. Click to retry.", {
      version: state.availableVersion,
    });
  }
  if (state.status === "available") {
    return state.availableVersion
      ? gt("Update {version} ready to download", { version: state.availableVersion })
      : gt("Update available to download");
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? gt("Downloading update ({percent}%)", { percent: Math.floor(state.downloadPercent) })
      : gt("Downloading update");
  }
  if (state.status === "downloaded") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return gt("Install failed for {version}. Click to retry.", {
        version: state.downloadedVersion,
      });
    }
    const version = state.downloadedVersion ?? state.availableVersion;
    const waiting =
      state.pendingRestartReason === "busy" || state.pendingRestartReason === "unknown";
    const downloaded = version
      ? gt("Update {version} downloaded. Click to restart and install.", { version })
      : gt("Update downloaded. Click to restart and install.");
    return waiting ? `${downloaded} ${gt("It also installs when you quit GOAT.")}` : downloaded;
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return gt("Install failed for {version}. Click to retry.", {
        version: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return gt("Update {version} downloaded. Click to restart and install.", {
        version: state.downloadedVersion,
      });
    }
    return translateDesktopUpdateMessage(state.message, gt) ?? gt("Update failed");
  }
  const buildChannel =
    cliReleaseChannelOf(state.currentVersion) === "nightly" ? "nightly" : "latest";
  if (state.status === "up-to-date" && buildChannel !== state.channel) {
    return gt(
      "This {build} build ignores {track} releases. Review the update track in Settings to finish the switch.",
      {
        build: buildChannel === "nightly" ? gt("Nightly") : gt("Stable"),
        track: state.channel === "nightly" ? gt("Nightly") : gt("Stable"),
      },
    );
  }
  return gt("Up to date");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const question = version
    ? gt("Install update {version} and restart GOAT?", { version })
    : gt("Install update and restart GOAT?");
  return `${question}\n\n${gt("Any running tasks will be interrupted. Make sure you're ready before continuing.")}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function getDesktopUpdateInstallError(
  result: DesktopUpdateActionResult,
  gt: DesktopUpdateTranslate = gtFallback,
): string | null {
  const message =
    result.completed || result.state.errorContext !== "install"
      ? getDesktopUpdateActionError(result)
      : result.state.message?.trim();
  return translateDesktopUpdateMessage(message || null, gt);
}

export async function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate" | "onUpdateState">,
): Promise<DesktopUpdateActionResult> {
  let awaitingFailure = false;
  let reportFailure: (state: DesktopUpdateState) => void = () => {};
  const failure = new Promise<DesktopUpdateState>((resolve) => {
    reportFailure = resolve;
  });
  const unsubscribe = bridge.onUpdateState((state) => {
    if (awaitingFailure && state.errorContext === "install") reportFailure(state);
  });
  try {
    const result = await bridge.installUpdate();
    if (!result.accepted || result.completed || getDesktopUpdateInstallError(result) !== null)
      return result;
    awaitingFailure = true;
    return { ...result, state: await failure };
  } finally {
    unsubscribe();
  }
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

/** A check or a later successful transfer must clear any recovery actions for the old offer. */
export function getDesktopUpdateTransferFailure(
  state: DesktopUpdateState | null,
  gt: DesktopUpdateTranslate = gtFallback,
) {
  if (!state?.enabled) return null;
  const stage = state.errorContext;
  if (
    (stage !== "download" && stage !== "install") ||
    resolveDesktopUpdateButtonAction(state) !== stage
  )
    return null;
  return {
    detail:
      translateDesktopUpdateMessage(state.message?.trim() || null, gt) ??
      (stage === "install" ? gt("Install failed.") : gt("Could not download update")),
    retryLabel: stage === "install" ? gt("Retry installation") : gt("Retry download"),
    releaseUrl: getDesktopUpdateReleaseUrl(
      stage === "install" ? state.downloadedVersion : state.availableVersion,
    ),
  };
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** Describes the app-owned automatic install policy and pending recovery. */
export function getDesktopUpdateStatusText(
  state: DesktopUpdateState,
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  if (!state.enabled)
    return (
      translateDesktopUpdateMessage(state.message, gt) ?? gt("Automatic updates are disabled.")
    );
  if (state.errorContext === "download" && state.message)
    return translateDesktopUpdateMessage(state.message, gt) ?? state.message;
  const checkError = getDesktopUpdateCheckError(state, gt);
  if (checkError) return checkError;
  if (state.installPolicy === "paused")
    return gt(
      "Automatic downloads and installation are paused. You can still check, download, and install manually.",
    );

  if (state.recoveryStatus === "needs-network")
    return gt("Connect to the network to restore the downloaded update.");
  if (state.recoveryStatus === "restoring") return gt("Restoring the downloaded update…");
  if (state.pendingRestartReason === "busy")
    return gt("Automatic restart postponed until backend work finishes.");
  if (state.pendingRestartReason === "unknown")
    return (
      translateDesktopUpdateMessage(state.message, gt) ??
      gt("Automatic restart postponed: backend activity cannot be verified.")
    );
  if (state.installPolicy === "install-on-quit")
    return state.downloadedVersion
      ? gt("The downloaded update will install when you quit the app.")
      : gt("Updates download automatically and install when you quit the app.");
  return gt(
    "Updates download automatically and restart the app when every backend is idle, or install when you quit.",
  );
}

// Only app-owned wording goes through translation. Service diagnostics remain literal values.
export function translateDesktopUpdateMessage(
  message: string | null | undefined,
  gt: DesktopUpdateTranslate,
): string | null {
  const downloadPrefix = "Download failed: ";
  if (message?.startsWith(downloadPrefix)) {
    return gt("Download failed: {error}", { error: message.slice(downloadPrefix.length) });
  }
  switch (message) {
    case "Automatic updates are not available because no update feed is configured.":
      return gt("Automatic updates are not available because no update feed is configured.");
    case "Automatic updates are only available in packaged production builds.":
      return gt("Automatic updates are only available in packaged production builds.");
    case "Automatic updates are disabled by the GOAT_DISABLE_AUTO_UPDATE setting.":
      return gt("Automatic updates are disabled by the GOAT_DISABLE_AUTO_UPDATE setting.");
    case "Automatic updates on Linux require the AppImage or the .deb package.":
      return gt("Automatic updates on Linux require the AppImage or the .deb package.");
    case "GOAT can't update itself while it runs from where it was downloaded. Move GOAT to Applications and reopen it. Servers this app connects to, including this Mac's SSH runtime, still update on their own.":
      return gt(
        "GOAT can't update itself while it runs from where it was downloaded. Move GOAT to Applications and reopen it. Servers this app connects to, including this Mac's SSH runtime, still update on their own.",
      );
    case "GOAT can't update itself from a read-only disk. Move GOAT to Applications and reopen it. Servers this app connects to, including this Mac's SSH runtime, still update on their own.":
      return gt(
        "GOAT can't update itself from a read-only disk. Move GOAT to Applications and reopen it. Servers this app connects to, including this Mac's SSH runtime, still update on their own.",
      );
    case "Your account can't write to GOAT or its folder, so installing updates needs an administrator. Servers this app connects to, including this Mac's SSH runtime, still update on their own.":
      return gt(
        "Your account can't write to GOAT or its folder, so installing updates needs an administrator. Servers this app connects to, including this Mac's SSH runtime, still update on their own.",
      );
    case "The installer was denied access. Check the permissions on GOAT and its folder, or ask an administrator before retrying.":
      return gt(
        "The installer was denied access. Check the permissions on GOAT and its folder, or ask an administrator before retrying.",
      );
    case "The installer encountered a read-only file system. Check that the installation location is writable before retrying.":
      return gt(
        "The installer encountered a read-only file system. Check that the installation location is writable before retrying.",
      );
    case "Could not clear the pending update record. Check again to retry.":
      return gt("Could not clear the pending update record. Check again to retry.");
    case "Could not persist the downloaded update. Retry the download.":
      return gt("Could not persist the downloaded update. Retry the download.");
    case "Automatic restart postponed: WSL activity cannot be verified.":
      return gt("Automatic restart postponed: WSL activity cannot be verified.");
    default:
      return message ?? null;
  }
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  gt: DesktopUpdateTranslate = gtFallback,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return (
    translateDesktopUpdateMessage(state.message?.trim() || null, gt) ??
    gt("Automatic updates are not available in this build.")
  );
}

/** Why the last update check failed, while that failure is the current state. */
export function getDesktopUpdateCheckError(
  state: Pick<
    DesktopUpdateState,
    "enabled" | "status" | "errorContext" | "downloadedVersion" | "message"
  > | null,
  gt: DesktopUpdateTranslate = gtFallback,
): string | null {
  if (
    !state?.enabled ||
    state.status !== "error" ||
    state.errorContext !== "check" ||
    state.downloadedVersion !== null
  )
    return null;
  const message = state.message?.trim();
  return message
    ? (translateDesktopUpdateMessage(message, gt) ?? message)
    : gt("Could not check for updates.");
}

/** The version row's description when no update is waiting. */
export function getDesktopUpdateIdleDescription(
  state: Parameters<typeof getDesktopUpdateCheckError>[0],
  gt: DesktopUpdateTranslate = gtFallback,
): string {
  return (
    getDesktopUpdateDisabledReason(state, gt) ??
    getDesktopUpdateCheckError(state, gt) ??
    gt("Current version of the application.")
  );
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<
    DesktopUpdateState,
    "enabled" | "status" | "errorContext" | "downloadedVersion" | "message"
  > | null,
  gt: DesktopUpdateTranslate = gtFallback,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, gt);
  if (disabledReason) return { title: gt("Updates unavailable"), detail: disabledReason };
  const checkError = getDesktopUpdateCheckError(state, gt);
  return checkError
    ? {
        title: gt("Update check failed"),
        detail: gt("{error} Click to check again.", { error: checkError }),
      }
    : { title: gt("Check for updates"), detail: null };
}
