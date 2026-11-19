import { gtFallback } from "gt-react";
import { describe, expect, it } from "vite-plus/test";
import { getDesktopUpdateStatusText } from "./desktopUpdate.logic";
import type { DesktopUpdateState } from "@goat/contracts";
import en from "../i18n/translations/en.json";
import ko from "../i18n/translations/ko.json";

import {
  canCheckForUpdate,
  type DesktopUpdateTranslate,
  getDesktopUpdateCheckError,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateIdleTooltip,
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
  it("shows why the last update check failed and lets the user check again", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "Could not check for updates: the update server did not answer within 2 minutes.",
      errorContext: "check",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(canCheckForUpdate(state)).toBe(true);
    expect(getDesktopUpdateIdleTooltip(state)).toEqual({
      title: "Update check failed",
      detail: `${state.message} Click to check again.`,
    });
    expect(getDesktopUpdateStatusText(state)).toBe(state.message);
  });

  it("offers restart for a downloaded update that waits for busy backends and says quitting installs it", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      pendingRestartReason: "busy",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Update 1.1.0 downloaded. Click to restart and install. It also installs when you quit GOAT.",
    );
  });

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

  it("shows the download failure after returning to available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Download failed for 1.1.0. Click to retry.");
    expect(getDesktopUpdateButtonTooltip({ ...state, notAppliedVersion: "1.1.0" })).toBe(
      "Update 1.1.0 did not apply. Click to retry.",
    );
  });

  it("never calls a build on the other track up to date", () => {
    // A Stable build whose switch to Nightly did not finish; the updater discards every release.
    const state: DesktopUpdateState = {
      ...baseState,
      status: "up-to-date",
      channel: "nightly",
      currentVersion: "0.1.5",
      checkedAt: "2026-11-18T00:00:00.000Z",
    };
    expect(getDesktopUpdateButtonTooltip(state)).not.toBe("Up to date");
    expect(
      getDesktopUpdateButtonTooltip({ ...state, currentVersion: "0.1.6-nightly.20261118.1" }),
    ).toBe("Up to date");
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
  it("passes version and diagnostics separately to the UI translator", () => {
    const gt: DesktopUpdateTranslate = (source, args) => {
      if (source === "Update {version} ready to download") {
        return gtFallback("可下载更新 {version}", args);
      }
      if (source === "{error} Click to check again.") {
        return gtFallback("{error} 点击重试。", args);
      }
      if (source === "Update check failed") return "更新检查失败";
      if (source === "Install update {version} and restart GOAT?") {
        return gtFallback("安装更新 {version} 并重启 GOAT？", args);
      }
      return gtFallback(source, args);
    };
    const state = { ...baseState, status: "available" as const, availableVersion: "1.1.0" };
    expect(getDesktopUpdateButtonTooltip(state, gt)).toBe("可下载更新 1.1.0");
    expect(getDesktopUpdateInstallConfirmationMessage(state, gt)).toContain(
      "安装更新 1.1.0 并重启 GOAT？",
    );
    expect(
      getDesktopUpdateIdleTooltip(
        {
          ...baseState,
          status: "error",
          errorContext: "check",
          message: "HTTP 504",
        },
        gt,
      ),
    ).toEqual({ title: "更新检查失败", detail: "HTTP 504 点击重试。" });
  });

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

it("translates the desktop's disabled reason across update surfaces and preserves external diagnostics", () => {
  const reason = "Automatic updates are not available because no update feed is configured.";
  const gt: DesktopUpdateTranslate = (source) =>
    source === reason ? "未配置更新源" : `translated: ${source}`;
  for (const [message, expected] of [
    [reason, "未配置更新源"],
    ["HTTP 503", "HTTP 503"],
  ] as const) {
    const state = { ...baseState, enabled: false, status: "disabled" as const, message };
    expect(getDesktopUpdateButtonTooltip(state, gt)).toBe(expected);
    expect(getDesktopUpdateIdleTooltip(state, gt).detail).toBe(expected);
    expect(getDesktopUpdateStatusText(state, gt)).toBe(expected);
  }
});

const englishCatalog = en as Record<string, string>;
const koreanCatalog = ko as Record<string, string>;

function translateFromCatalog(source: string): string {
  const id = Object.keys(englishCatalog).find((key) => englishCatalog[key] === source);
  return id ? (koreanCatalog[id] ?? source) : source;
}

it("translates an app-owned installation sentence from the catalog", () => {
  const sentence =
    "Your account can't write to GOAT or its folder, so installing updates needs an administrator. Servers this app connects to, including this Mac's SSH runtime, still update on their own.";
  const translated = translateFromCatalog(sentence);
  expect(translated).not.toBe(sentence);
  const gt: DesktopUpdateTranslate = (source, args) => {
    const value = translateFromCatalog(String(source));
    return args ? gtFallback(value, args) : value;
  };
  const state: DesktopUpdateState = {
    ...baseState,
    status: "downloaded",
    downloadedVersion: "1.2.4",
    installationNotice: sentence,
  };
  const tooltip = getDesktopUpdateButtonTooltip(state, gt);
  expect(tooltip).toContain(translated);
  expect(tooltip).not.toContain("needs an administrator");
});

it("passes a braced diagnostic through unchanged without an ICU error", () => {
  const diagnostic = "Could not check for updates: updater failed {service}";
  const gt: DesktopUpdateTranslate = (source, args) => {
    const text = String(source);
    const known = Object.keys(englishCatalog).some((key) => englishCatalog[key] === text);
    if (!known && text.includes("{")) throw new Error(`ICU ${text}`);
    const value = translateFromCatalog(text);
    return args ? gtFallback(value, args) : value;
  };
  const state: DesktopUpdateState = {
    ...baseState,
    status: "error",
    errorContext: "check",
    message: diagnostic,
  };
  expect(getDesktopUpdateCheckError(state, gt)).toBe(diagnostic);
  expect(getDesktopUpdateStatusText(state, gt)).toBe(diagnostic);
  expect(getDesktopUpdateIdleTooltip(state, gt).detail).toContain(diagnostic);
});
