import { GTProvider } from "gt-react";
import ko from "../../i18n/translations/ko.json";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettingsPatch,
  type DesktopSnapShotState,
} from "@goat/contracts";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({
  getSnapShotState: vi.fn<() => Promise<DesktopSnapShotState>>(),
  setSnapShotShortcutSuppressed: vi.fn(),
  checkSnapShotShortcut: vi.fn(),
  previewSnapShotConfig: vi.fn(),
  applySnapShotConfig: vi.fn(),
  setupSnapShot: vi.fn(),
  requestSnapShotPermissions: vi.fn(),
  onMenuAction: vi.fn(),
  onSnapShotEvent: vi.fn(() => () => undefined),
}));
const toast = vi.hoisted(() => vi.fn());
// Client settings behave like the real store: an update re-renders every reader.
const settingsStore = vi.hoisted(() => ({
  current: {} as typeof DEFAULT_CLIENT_SETTINGS,
  listeners: new Set<() => void>(),
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<boolean>>(),
  set(next: typeof DEFAULT_CLIENT_SETTINGS) {
    settingsStore.current = next;
    for (const listener of settingsStore.listeners) listener();
  },
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: ((options?: { select?: (location: unknown) => unknown }) =>
    options?.select?.({ hash: "", pathname: "/settings/snapshots", state: {} }) ?? "") as never,
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../lib/desktopSnapShot"), async (original) => ({
  ...(await original()),
  getDesktopSnapShotBridge: () => bridge as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    settingsStore.listeners.add(listener);
    return () => settingsStore.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useClientSettings: (() =>
      useSyncExternalStore(subscribe, () => settingsStore.current)) as never,
    updateClientSettings: settingsStore.update as never,
  };
});

import { SnapShotSettings } from "./SnapShotSettings";

it("keeps a failed preference unchanged without adding its own error", async () => {
  vi.clearAllMocks();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  settingsStore.current = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
  const shortcut = {
    key: "2",
    modKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
  };
  settingsStore.current = { ...settingsStore.current, snapShotShortcut: shortcut };
  let state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut,
    shortcutRegistered: true,
    shortcutActionRegistered: true,
    shortcutMessage: null,
    message: null,
    gnomeExtension: { status: "enabled", message: "Ready" },
    linuxFeedbackAvailable: true,
    shortcutCanRetry: true,
  };
  bridge.getSnapShotState.mockImplementation(async () => state);
  bridge.setSnapShotShortcutSuppressed.mockResolvedValue(undefined);
  bridge.checkSnapShotShortcut.mockResolvedValue({ available: true, message: null });
  bridge.requestSnapShotPermissions.mockResolvedValue(undefined);
  bridge.setupSnapShot.mockReset().mockResolvedValue(undefined);
  settingsStore.update.mockReset().mockImplementation(async (patch) => {
    state = { ...state, shortcut: patch.snapShotShortcut ?? state.shortcut };
    settingsStore.set({ ...settingsStore.current, ...patch });
    return true;
  });
  settingsStore.update.mockResolvedValueOnce(false);
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <GTProvider locale="ko" translations={{ ko }}>
        <SnapShotSettings />
      </GTProvider>,
    ),
  );
  await vi.waitFor(() => expect(bridge.getSnapShotState).toHaveBeenCalled());
  await act(async () => settingsStore.set({ ...settingsStore.current, snapShotPlaySound: false }));
  await expect.element(screen.getByRole("button", { name: "끔 캡처 효과음" })).toBeVisible();
  await act(async () =>
    settingsStore.set({
      ...settingsStore.current,
      snapShotPlaySound: true,
      snapShotSound: "soft-pop",
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "휙 (기본값) 캡처 효과음" }))
    .toBeVisible();
  await act(async () =>
    settingsStore.set({ ...settingsStore.current, snapShotSound: "camera-shutter" }),
  );
  await expect.element(screen.getByRole("button", { name: "클릭 캡처 효과음" })).toBeVisible();
  const flash = () =>
    screen.container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="캡처한 창 깜박이기"]',
    )!;
  expect(flash().getAttribute("aria-checked")).toBe("true");
  await act(async () => flash().click());
  expect(flash().getAttribute("aria-checked")).toBe("true");
  expect(toast).not.toHaveBeenCalled();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => flash().click());
  expect(flash().getAttribute("aria-checked")).toBe("false");
  expect(toast).not.toHaveBeenCalled();
});
