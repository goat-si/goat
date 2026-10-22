import { describe, expect, it } from "vite-plus/test";
import { getDesktopUpdateStatusText } from "./desktopUpdate.logic";
import type { DesktopUpdateState } from "@goat/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  installPolicy: "restart-when-idle",
  pendingRestartReason: null,
  pendingUpdate: null,
  recoveryStatus: null,
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30", "")).toBe(
      "https://github.com/goat-si/goat-releases/releases/tag/v0.0.30",
    );
  });

  it.each([
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo#notes",
    "owner?tab=notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to the GOAT releases for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/goat-si/goat-releases/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/goat-si/goat-releases/releases/tag/v1.2.3",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931", "")).toBe(
      "https://github.com/goat-si/goat-releases/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl("")).toBe(
      "https://github.com/goat-si/goat-releases/releases",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("keeps administrator advice next to the app action without blocking checks", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.2.4",
      installationNotice: "Ask an administrator. Servers can still update independently.",
    };
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to restart and install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain(state.installationNotice);
    expect(canCheckForUpdate(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("shows the installation restriction instead of a generic disabled status", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      enabled: false,
      status: "disabled",
      message: "Move GOAT to Applications. Servers can still update independently.",
    };
    expect(getDesktopUpdateButtonTooltip(state)).toBe(state.message);
    expect(getDesktopUpdateStatusText(state)).toBe(state.message);
    expect(canCheckForUpdate(state)).toBe(false);
  });
});

it("describes automatic policy, pending work and network recovery", () => {
  expect(getDesktopUpdateStatusText({ ...baseState, installPolicy: "paused" })).toContain("paused");
  expect(getDesktopUpdateStatusText({ ...baseState, pendingRestartReason: "busy" })).toContain(
    "backend work finishes",
  );
  expect(
    getDesktopUpdateStatusText({
      ...baseState,
      pendingRestartReason: "unknown",
      message: "Automatic restart postponed: WSL activity cannot be verified.",
    }),
  ).toContain("WSL");
  expect(
    getDesktopUpdateStatusText({
      ...baseState,
      installPolicy: "install-on-quit",
      downloadedVersion: "1.2.4",
    }),
  ).toContain("when you quit");
  expect(getDesktopUpdateStatusText({ ...baseState, recoveryStatus: "needs-network" })).toContain(
    "network",
  );
  expect(getDesktopUpdateStatusText({ ...baseState, recoveryStatus: "restoring" })).toContain(
    "Restoring",
  );
});

it("shows download failures instead of recovery advice", () => {
  expect(
    getDesktopUpdateStatusText({
      ...baseState,
      recoveryStatus: "restoring",
      errorContext: "download",
      message: "checksum mismatch",
    }),
  ).toBe("checksum mismatch");
});
it("does not show recovery advice when the updater is disabled", () => {
  expect(
    getDesktopUpdateStatusText({ ...baseState, enabled: false, recoveryStatus: "restoring" }),
  ).toBe("Automatic updates are disabled.");
});
