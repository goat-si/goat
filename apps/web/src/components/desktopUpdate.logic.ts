import { gtFallback, msg, type useGT } from "gt-react";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@goat/contracts";
import { CLI_RELEASE_REPOSITORY } from "@goat/shared/cliRelease";

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
    return translateDisabledMessage(state.message, gt) ?? gt("Automatic updates are disabled.");
  const actionTooltip = getDesktopUpdateActionTooltip(state, gt);
  return state.installationNotice ? `${actionTooltip}\n${state.installationNotice}` : actionTooltip;
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
    const version = state.downloadedVersion ?? state.availableVersion;
    const waiting =
      state.pendingRestartReason === "busy" || state.pendingRestartReason === "unknown";
    const downloaded = version
      ? gt("Update {version} downloaded. Click to restart and install.", { version })
      : gt("Update downloaded. Click to restart and install.");
    return waiting ? `${downloaded} ${gt("It also installs when you quit GOAT.")}` : downloaded;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return gt("Download failed for {version}. Click to retry.", {
        version: state.availableVersion,
      });
    }
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
    return state.message ?? gt("Update failed");
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

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
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
    return translateDisabledMessage(state.message, gt) ?? gt("Automatic updates are disabled.");
  if (state.errorContext === "download" && state.message) return state.message;
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
    return state.message ?? gt("Automatic restart postponed: backend activity cannot be verified.");
  if (state.installPolicy === "install-on-quit")
    return state.downloadedVersion
      ? gt("The downloaded update will install when you quit the app.")
      : gt("Updates download automatically and install when you quit the app.");
  return gt(
    "Updates download automatically and restart the app when every backend is idle, or install when you quit.",
  );
}

// The desktop bridge can also supply diagnostics from the OS or update service.
const disabledMessages = new Set<string>([
  msg("Automatic updates are not available because no update feed is configured."),
  msg("Automatic updates are only available in packaged production builds."),
  msg("Automatic updates are disabled by the GOAT_DISABLE_AUTO_UPDATE setting."),
  msg("Automatic updates on Linux require the AppImage or the .deb package."),
]);
function translateDisabledMessage(message: string | null, gt: DesktopUpdateTranslate) {
  return message && disabledMessages.has(message) ? gt(message) : message;
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  gt: DesktopUpdateTranslate = gtFallback,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return (
    translateDisabledMessage(state.message?.trim() || null, gt) ??
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
  return state.message?.trim() || gt("Could not check for updates.");
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
