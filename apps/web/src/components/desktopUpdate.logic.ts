import type { DesktopUpdateActionResult, DesktopUpdateState } from "@goat/contracts";
import { CLI_RELEASE_REPOSITORY } from "@goat/shared/cliRelease";

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

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but GOAT is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (!state.enabled) return state.message ?? "Automatic updates are disabled.";
  const actionTooltip = getDesktopUpdateActionTooltip(state);
  return state.installationNotice ? `${actionTooltip}\n${state.installationNotice}` : actionTooltip;
}

function getDesktopUpdateActionTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    const waiting =
      state.pendingRestartReason === "busy" || state.pendingRestartReason === "unknown"
        ? " It also installs when you quit GOAT."
        : "";
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.${waiting}`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart GOAT?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
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
export function getDesktopUpdateStatusText(state: DesktopUpdateState): string {
  if (!state.enabled) return state.message ?? "Automatic updates are disabled.";
  if (state.errorContext === "download" && state.message) return state.message;
  const checkError = getDesktopUpdateCheckError(state);
  if (checkError) return checkError;
  if (state.installPolicy === "paused")
    return "Automatic downloads and installation are paused. You can still check, download, and install manually.";

  if (state.recoveryStatus === "needs-network")
    return "Connect to the network to restore the downloaded update.";
  if (state.recoveryStatus === "restoring") return "Restoring the downloaded update…";
  if (state.pendingRestartReason === "busy")
    return "Automatic restart postponed until backend work finishes.";
  if (state.pendingRestartReason === "unknown")
    return state.message ?? "Automatic restart postponed: backend activity cannot be verified.";
  if (state.installPolicy === "install-on-quit")
    return state.downloadedVersion
      ? "The downloaded update will install when you quit the app."
      : "Updates download automatically and install when you quit the app.";
  return "Updates download automatically and restart the app when every backend is idle, or install when you quit.";
}

function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

/** Why the last update check failed, while that failure is the current state. */
export function getDesktopUpdateCheckError(
  state: Pick<
    DesktopUpdateState,
    "enabled" | "status" | "errorContext" | "downloadedVersion" | "message"
  > | null,
): string | null {
  if (
    !state?.enabled ||
    state.status !== "error" ||
    state.errorContext !== "check" ||
    state.downloadedVersion !== null
  )
    return null;
  return state.message?.trim() || "Could not check for updates.";
}

/** The version row's description when no update is waiting. */
export function getDesktopUpdateIdleDescription(
  state: Parameters<typeof getDesktopUpdateCheckError>[0],
): string {
  return (
    getDesktopUpdateDisabledReason(state) ??
    getDesktopUpdateCheckError(state) ??
    "Current version of the application."
  );
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<
    DesktopUpdateState,
    "enabled" | "status" | "errorContext" | "downloadedVersion" | "message"
  > | null,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state);
  if (disabledReason) return { title: "Updates unavailable", detail: disabledReason };
  const checkError = getDesktopUpdateCheckError(state);
  return checkError
    ? { title: "Update check failed", detail: `${checkError} Click to check again.` }
    : { title: "Check for updates", detail: null };
}
