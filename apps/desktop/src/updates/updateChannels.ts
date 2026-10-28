import type { DesktopUpdateChannel } from "@goat/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;
// A PR build keeps stable's app id and Computer Use helper, so only its state moves beside stable.
const PR_PREVIEW_VERSION_PATTERN = /^[^-+]+-pr\.\d+\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

/** Whether a packaged build keeps its state in the nightly home, so it never migrates stable's. */
export function usesNightlyDesktopState(version: string): boolean {
  return isNightlyDesktopVersion(version) || PR_PREVIEW_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
