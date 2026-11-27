import type { DesktopBridge, DesktopUpdateState } from "@goat/contracts";
import { GTProvider, gtFallback } from "gt-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import chinese from "../../i18n/translations/zh.json";
import { clearDismissedDownloadFailure } from "../../state/desktopUpdate";
import { AboutVersionSection } from "../settings/AboutVersionSection";
import { ToastProvider } from "../ui/toast";
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
    if (update) clearDismissedDownloadFailure(update);
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("manual desktop update checks", () => {
  const current: DesktopUpdateState = {
    ...nightlyUpdate([]),
    status: "up-to-date",
    channel: "latest",
    currentVersion: "0.1.14",
    availableVersion: null,
    checkedAt: "2026-11-27T03:00:00Z",
  };
  const checking: DesktopUpdateState = {
    ...current,
    status: "checking",
    checkedAt: "2026-11-27T03:10:00Z",
  };
  const complete = { ...current, checkedAt: "2026-11-27T03:10:03Z" };

  function renderEntries(locale: "en" | "zh" = "en") {
    setup(current);
    return render(
      <GTProvider locale={locale} translations={{ en: {}, zh: chinese }}>
        <ToastProvider>
          <SidebarUpdatePill placement="rail" />
          <AboutVersionSection />
        </ToastProvider>
      </GTProvider>,
    );
  }

  function stubUpdater(checkForUpdate: DesktopBridge["checkForUpdate"]) {
    return stubGlobal("desktopBridge", {
      getLocalEnvironmentBootstraps: () => [],
      checkForUpdate,
      getUpdateState: async () => mocks.update!,
      onUpdateState: (listener: (state: DesktopUpdateState) => void) =>
        mocks.subscribe(() => {
          if (mocks.update) listener(mocks.update);
        }),
    });
  }

  function expectToastDescription(text: string) {
    return vi.waitFor(() =>
      expect(document.querySelector('[data-slot="toast-description"]')?.textContent).toBe(text),
    );
  }

  it.each(["reply", "late event", "early event"] as const)(
    "confirms a manual check completed via %s",
    async (via) => {
      const reply = Promise.withResolvers<Awaited<ReturnType<DesktopBridge["checkForUpdate"]>>>();
      const checkForUpdate = vi.fn(() => reply.promise);
      using _bridge = stubUpdater(checkForUpdate);
      await using screen = await renderEntries();
      await publish({ ...current });
      const descriptions = () => document.querySelectorAll('[data-slot="toast-description"]');
      expect(descriptions()).toHaveLength(0);

      const button = screen.getByRole("button", { name: "Check for updates" });
      const trigger = button.element();
      await button.click();
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      if (via === "early event") await publish(complete);
      await act(() =>
        reply.resolve({ checked: true, state: via === "reply" ? complete : checking }),
      );
      if (via === "late event") {
        expect(descriptions()).toHaveLength(0);
        await publish(complete);
      }
      await expect.element(page.getByText("GOAT 0.1.14", { exact: true })).toBeVisible();
      await expectToastDescription("Up to date");
      await publish(complete);
      expect(descriptions()).toHaveLength(1);
    },
  );

  it.each(["检查更新", "已是最新版本"])("confirms a check from %s in Chinese", async (label) => {
    using _bridge = stubUpdater(async () => ({
      checked: true,
      state: {
        ...complete,
        installationNotice: "Administrator permissions required for installation.",
      },
    }));
    await using screen = await renderEntries("zh");
    await screen.getByRole("button", { name: label, exact: true }).click();
    await expectToastDescription("已是最新版本");
  });

  it("shares one pending check across both entry points", async () => {
    const reply = Promise.withResolvers<Awaited<ReturnType<DesktopBridge["checkForUpdate"]>>>();
    const checkForUpdate = vi.fn(() => reply.promise);
    using _bridge = stubUpdater(checkForUpdate);
    await using screen = await renderEntries();
    await screen.getByRole("button", { name: "Up to Date", exact: true }).click();
    await screen.getByRole("button", { name: "Check for updates", exact: true }).click();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await act(() => reply.resolve({ checked: true, state: complete }));
    await expectToastDescription("Up to date");
  });

  it("ignores an old snapshot and a completion from another channel", async () => {
    const read = vi.fn(async () => current);
    using _bridge = stubGlobal("desktopBridge", {
      getLocalEnvironmentBootstraps: () => [],
      checkForUpdate: async () => ({ checked: true, state: checking }),
      getUpdateState: read,
      onUpdateState: (listener: (state: DesktopUpdateState) => void) =>
        mocks.subscribe(() => listener(mocks.update!)),
    });
    await using screen = await renderEntries();
    const button = screen.getByRole("button", { name: "Up to Date", exact: true });
    await button.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await publish({ ...complete, channel: "nightly" });
    await expect.element(button).toBeEnabled();
    expect(document.querySelector('[data-slot="toast-description"]')).toBeNull();
  });

  it.each(["refused", "rejected"])("reports a %s check from settings", async (reason) => {
    const message = "Update service unavailable";
    using _bridge = stubUpdater(async () => {
      if (reason === "rejected") throw new Error(message);
      return { checked: false, state: { ...current, enabled: false, message } };
    });
    await using screen = await renderEntries();
    await screen.getByRole("button", { name: "Up to Date", exact: true }).click();
    await expectToastDescription(message);
  });

  it("keeps the existing update offer when a new version is available", async () => {
    sessionStorage.removeItem("desktop-update-notice");
    const available: DesktopUpdateState = {
      ...complete,
      status: "available",
      availableVersion: "0.1.15",
    };
    using _bridge = stubGlobal("desktopBridge", {
      getLocalEnvironmentBootstraps: () => [],
      checkForUpdate: async () => ({ checked: true, state: available }),
    });
    await using screen = await renderEntries();
    await screen.getByRole("button", { name: "Check for updates" }).click();
    await publish(available);
    await expect
      .element(page.getByRole("complementary", { name: "Update available" }))
      .toBeVisible();
    expect(document.querySelector('[data-slot="toast-description"]')).toBeNull();
  });

  it("shows the error when an accepted check fails", async () => {
    const message = "The update service is offline.";
    using _bridge = stubGlobal("desktopBridge", {
      getLocalEnvironmentBootstraps: () => [],
      checkForUpdate: async () => ({
        checked: true,
        state: { ...complete, status: "error", errorContext: "check", message },
      }),
    });
    await using screen = await renderEntries();
    await screen.getByRole("button", { name: "Check for updates" }).click();
    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  });
});

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

  it("keeps a dismissed failure hidden across remounts until a new failure", async () => {
    sessionStorage.removeItem("desktop-update-notice");
    sessionStorage.removeItem("desktop-update-failure-dismissed");
    const update = nightlyUpdate([]);
    const failure = { ...update, errorContext: "download" as const, canRetry: true };
    setup(failure);
    const notice = () => document.querySelector('aside[aria-label="Update available"]');
    {
      await using _screen = await render(<SidebarUpdatePill />);
      expect(notice()?.textContent).toContain("Retry");
      await userEvent.click(notice()!.querySelector('button[aria-label="Close"]')!);
      expect(notice()).toBeNull();
    }
    {
      await using _screen = await render(<SidebarUpdatePill />);
      expect(notice()).toBeNull();
      await publish({ ...update, status: "downloading", downloadPercent: 20 });
      await publish(failure);
      expect(notice()?.textContent).toContain("Retry");
      await userEvent.click(notice()!.querySelector('button[aria-label="Close"]')!);
    }
    await publish({ ...update, status: "downloading", downloadPercent: 20 });
    await publish(failure);
    {
      await using _screen = await render(<SidebarUpdatePill />);
      expect(notice()?.textContent).toContain("Retry");
    }
    sessionStorage.removeItem("desktop-update-notice");
    sessionStorage.removeItem("desktop-update-failure-dismissed");
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
    onUpdateState: () => () => {},
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
  } satisfies Pick<DesktopBridge, "installUpdate" | "onUpdateState">;
  const reportError = vi.fn();
  expect(
    await installLocalUpdate(bridge as unknown as DesktopBridge, gtFallback, reportError),
  ).toBe(false);
  expect(reportError).toHaveBeenCalledExactlyOnceWith("Could not install update", message);
});
