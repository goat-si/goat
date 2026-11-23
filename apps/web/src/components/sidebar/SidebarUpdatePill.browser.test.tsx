import type { DesktopBridge, DesktopUpdateState } from "@goat/contracts";
import { gtFallback } from "gt-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { installLocalUpdate, SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", async (original) => ({
  ...(await original<typeof import("./useUpdateEverything")>()),
  useUpdateEverything: () => ({ hasUpdates: false, summary: "", lines: [], restarts: [] }),
}));

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    installPolicy: "restart-when-idle",
    pendingRestartReason: null,
    pendingUpdate: null,
    recoveryStatus: null,
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(update: DesktopUpdateState | null) {
  mocks.update = update;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("SidebarUpdatePill release notes", () => {
  it("keeps a dismissed offer quiet and surfaces a subsequent download failure", async () => {
    sessionStorage.removeItem("desktop-update-notice");
    const update = nightlyUpdate([]);
    setup(update);
    await using _screen = await render(<SidebarUpdatePill />);
    const notice = () => document.querySelector('aside[aria-label="Update available"]');
    const versionChange = `${update.currentVersion}→${update.availableVersion}`;
    expect(notice()?.textContent).toContain(versionChange);
    await userEvent.click(notice()!.querySelector('button[aria-label="Close"]')!);
    await publish({ ...update, status: "downloading", downloadPercent: 80 });
    expect(notice()).toBeNull();
    await publish({ ...update, errorContext: "download", canRetry: true });
    expect(notice()?.textContent).toContain("Retry");
    expect(notice()?.textContent).toContain(versionChange);
    sessionStorage.removeItem("desktop-update-notice");
  });

  it("shows each new failure after a dismissed retry without reopening the offer (#3808)", async () => {
    sessionStorage.removeItem("desktop-update-notice");
    const update = nightlyUpdate([]);
    const failure = {
      ...update,
      errorContext: "download" as const,
      canRetry: true,
      message: "offline",
    };
    setup(failure);
    await using _screen = await render(<SidebarUpdatePill />);
    const notice = () => document.querySelector('aside[aria-label="Update available"]');
    expect(notice()?.textContent).toContain("Retry");
    await userEvent.click(notice()!.querySelector('button[aria-label="Close"]')!);
    await publish({ ...update, status: "downloading", downloadPercent: 20 });
    expect(notice()).toBeNull();
    await publish(failure);
    expect(notice()?.textContent).toContain("Retry");
    sessionStorage.removeItem("desktop-update-notice");
  });

  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(nightlyUpdate(RELEASE_NOTES));
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());
  });
});

it("reports a refused install refresh timeout as an error", async () => {
  const message = "Desktop update check on channel nightly did not finish within 2 minutes.";
  const bridge = {
    installUpdate: async () => ({
      accepted: false,
      completed: false,
      state: {
        ...nightlyUpdate([]),
        status: "downloaded",
        downloadedVersion: "0.0.50-nightly.2",
        errorContext: "install",
        canRetry: true,
        message,
      },
    }),
  } satisfies Pick<DesktopBridge, "installUpdate">;
  const reportError = vi.fn();
  expect(await installLocalUpdate(bridge as DesktopBridge, gtFallback, reportError)).toBe(false);
  expect(reportError).toHaveBeenCalledExactlyOnceWith("Could not install update", message);
});
