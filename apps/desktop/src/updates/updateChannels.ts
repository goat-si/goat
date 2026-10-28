import type { DesktopUpdateChannel } from "@goat/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// Dated and PR preview builds share nightly branding and state but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:(?:nightly|preview)\.\d{8}|pr\.\d+)\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
