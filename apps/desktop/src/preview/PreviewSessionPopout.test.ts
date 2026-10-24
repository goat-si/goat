import * as NodeEvents from "node:events";
import type * as Electron from "electron";
import { PREVIEW_SESSION_STACK_WINDOW_NAME } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { PREVIEW_SESSION_STACK_CHANNEL } from "../ipc/channels.ts";
import { PreviewSessionPopout } from "./PreviewSessionPopout.ts";

const native = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  getDisplayMatching: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({ ipcMain: native, screen: native }));

function fakeWindow() {
  let visible = false;
  let destroyed = false;
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents: Object.assign(new NodeEvents.EventEmitter(), {
      mainFrame: {},
      isDestroyed: () => false,
      send: vi.fn(),
      getZoomFactor: () => 2,
      setZoomFactor: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }),
    getBounds: () => ({ x: -1600, y: 0, width: 1200, height: 800 }),
    getContentBounds: () => ({ x: -1600, y: 100, width: 1200, height: 700 }),
    setBounds: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setContentProtection: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    showInactive: vi.fn(() => {
      visible = true;
      window.emit("show");
    }),
    hide: vi.fn(() => {
      visible = false;
      window.emit("hide");
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
      window.emit("closed");
    }),
  });
  return window;
}

const details = {
  url: "about:blank",
  frameName: PREVIEW_SESSION_STACK_WINDOW_NAME,
  features: "",
  disposition: "new-window",
  referrer: { url: "goat://app/", policy: "default" },
} satisfies Electron.HandlerDetails;

function setup(platform = "darwin", poppedOut = false, version = "10.0.19045") {
  native.handle.mockClear();
  native.getDisplayMatching.mockReturnValue({
    workArea: { x: -1600, y: 24, width: 1600, height: 900 },
  });
  const owner = fakeWindow();
  const persist = vi.fn<(_: boolean) => Promise<void>>(async () => undefined);
  const onError = vi.fn();
  const manager = new PreviewSessionPopout(
    owner as unknown as Electron.BrowserWindow,
    platform,
    poppedOut,
    persist,
    onError,
    version,
  );
  const handler = native.handle.mock.calls[0]?.[1] as (
    event: { sender: unknown; senderFrame: unknown },
    raw: unknown,
  ) => Promise<unknown>;
  const request = (raw: unknown) =>
    handler({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, raw);
  const child = fakeWindow();
  const attach = () => {
    expect(manager.open(details)?.action).toBe("allow");
    owner.webContents.emit("did-create-window", child, details);
  };
  return {
    owner,
    child,
    manager,
    handler,
    persist,
    request,
    attach,
    onError,
    [Symbol.dispose]() {
      owner.emit("closed");
    },
  };
}

it("creates an inactive transparent panel on the owner's display and protects it before showing", async () => {
  using fixture = setup();
  const options = fixture.manager.open(details)?.overrideBrowserWindowOptions;
  expect(options).toMatchObject({
    x: -296,
    y: 24,
    width: 296,
    height: 1,
    focusable: false,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    type: "panel",
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  expect(native.getDisplayMatching).toHaveBeenCalledWith(fixture.owner.getBounds());
  fixture.attach();
  expect(fixture.child.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
  expect(fixture.child.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
    visibleOnFullScreen: true,
  });
  expect(fixture.child.setContentProtection).toHaveBeenCalledWith(true);
  expect(fixture.child.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  expect(fixture.child.showInactive).not.toHaveBeenCalled();
  await fixture.request({ type: "layout", height: 340 });
  expect(fixture.child.setBounds).toHaveBeenLastCalledWith(
    { x: -296, y: 24, width: 296, height: 340 },
    false,
  );
  expect(fixture.child.showInactive).toHaveBeenCalledOnce();
  expect(fixture.persist).toHaveBeenCalledWith(true);
});

it.each([
  ["darwin", "24.0.0", "macos-sharing-none"],
  ["win32", "10.0.19045", "windows-exclude-from-capture"],
  ["win32", "10.0.18363", "windows-monitor-only"],
  ["linux", "6.8.0", "unsupported"],
])("reports capture limitations on %s %s", async (platform, version, capability) => {
  using fixture = setup(platform, false, version);
  fixture.attach();
  const state = await fixture.request({ type: "layout", height: 50 });
  expect(state).toMatchObject({ captureProtection: capability });
  if (platform === "linux") expect(fixture.child.setContentProtection).not.toHaveBeenCalled();
  else expect(fixture.child.setContentProtection).toHaveBeenCalledWith(true);
});

it("changes click-through only for interactive regions and resets it on hide", async () => {
  using fixture = setup();
  fixture.attach();
  await fixture.request({ type: "layout", height: 100 });
  await fixture.request({ type: "interactive", interactive: true });
  expect(fixture.child.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
  await fixture.request({ type: "interactive", interactive: false });
  expect(fixture.child.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
  await fixture.request({ type: "layout", height: 0 });
  expect(await fixture.request({ type: "state" })).toMatchObject({
    visible: false,
    poppedOut: true,
  });
});

it("avoids owner CSS points until explicitly cleared, hiding if neither half is safe", async () => {
  using fixture = setup();
  fixture.attach();
  await fixture.request({ type: "layout", height: 300 });
  await fixture.request({ type: "pointer", tabId: "tab-1", point: { x: 700, y: 20 } });
  expect(fixture.child.setBounds).toHaveBeenLastCalledWith(
    { x: -296, y: 624, width: 296, height: 300 },
    false,
  );
  // A later resize is not an action-end signal and must retain avoidance.
  await fixture.request({ type: "layout", height: 310 });
  expect(fixture.child.setBounds).toHaveBeenLastCalledWith(
    { x: -296, y: 614, width: 296, height: 310 },
    false,
  );
  await fixture.request({ type: "layout", height: 900 });
  expect(await fixture.request({ type: "state" })).toMatchObject({ visible: false });
  await fixture.request({ type: "pointer", tabId: "tab-1", point: null });
  expect(await fixture.request({ type: "state" })).toMatchObject({ visible: true });
  expect(fixture.child.setBounds).toHaveBeenLastCalledWith(
    { x: -296, y: 24, width: 296, height: 900 },
    false,
  );
});

it("follows the owner's display changes and keeps every concurrent agent point uncovered", async () => {
  using fixture = setup();
  fixture.attach();
  await fixture.request({ type: "layout", height: 300 });
  await fixture.request({ type: "pointer", tabId: "top", point: { x: 700, y: 20 } });
  await fixture.request({ type: "pointer", tabId: "bottom", point: { x: 700, y: 350 } });
  expect(await fixture.request({ type: "state" })).toMatchObject({ visible: false });
  await fixture.request({ type: "pointer", tabId: "bottom", point: null });
  expect(await fixture.request({ type: "state" })).toMatchObject({ visible: true });
  native.getDisplayMatching.mockReturnValue({
    workArea: { x: 0, y: -1000, width: 1920, height: 1000 },
  });
  fixture.owner.emit("move");
  expect(fixture.child.setBounds).toHaveBeenLastCalledWith(
    { x: 1624, y: -1000, width: 296, height: 300 },
    false,
  );
});

it("persists Dock and native close but preserves the preference when the owner closes", async () => {
  using fixture = setup("darwin", true);
  fixture.attach();
  await fixture.request({ type: "layout", height: 100 });
  const prevented = vi.fn();
  fixture.child.emit("close", { preventDefault: prevented });
  // The state request is queued behind the native close, without polling.
  expect(await fixture.request({ type: "state" })).toMatchObject({
    poppedOut: false,
    visible: false,
  });
  expect(prevented).toHaveBeenCalledOnce();
  expect(fixture.persist).toHaveBeenCalledWith(false);
  fixture.attach();
  await fixture.request({ type: "layout", height: 100 });
  fixture.persist.mockClear();
  fixture.owner.emit("close");
  expect(fixture.child.destroy).toHaveBeenCalled();
  expect(fixture.persist).not.toHaveBeenCalled();
});

it("does not show or discard a window when preference persistence fails", async () => {
  using fixture = setup();
  fixture.attach();
  fixture.persist.mockRejectedValueOnce(new Error("disk full"));
  await expect(fixture.request({ type: "layout", height: 100 })).rejects.toThrow("disk full");
  expect(fixture.child.showInactive).not.toHaveBeenCalled();
  await fixture.request({ type: "layout", height: 100 });
  fixture.persist.mockRejectedValueOnce(new Error("read only"));
  await expect(fixture.request({ type: "dock" })).rejects.toThrow("read only");
  expect(fixture.child.destroy).not.toHaveBeenCalled();
});

it("does not resurrect a child when its owner closes during preference persistence", async () => {
  using fixture = setup();
  fixture.attach();
  let started: (() => void) | undefined;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish: (() => void) | undefined;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fixture.persist.mockImplementationOnce(() => {
    started?.();
    return saved;
  });
  const pending = fixture.request({ type: "layout", height: 300 });
  await saving;
  fixture.owner.emit("close");
  finish?.();
  await pending;
  expect(fixture.child.showInactive).not.toHaveBeenCalled();
  expect(await fixture.request({ type: "state" })).toMatchObject({ open: false, visible: false });
});

it("rejects foreign/child frames and malformed requests, and blocks child navigation and guests", async () => {
  using fixture = setup();
  expect(() =>
    fixture.handler({ sender: fixture.child.webContents, senderFrame: {} }, { type: "dock" }),
  ).toThrow("owning main frame");
  expect(() =>
    fixture.handler({ sender: fixture.owner.webContents, senderFrame: {} }, { type: "dock" }),
  ).toThrow("owning main frame");
  expect(() => fixture.request({ type: "layout", height: -1 })).toThrow();
  expect(() =>
    fixture.request({ type: "pointer", tabId: "tab-1", point: { x: Infinity, y: 0 } }),
  ).toThrow();
  expect(fixture.manager.open({ ...details, url: "https://example.test" })).toBeUndefined();
  fixture.attach();
  expect(fixture.manager.open(details)?.action).toBe("deny");
  const preventDefault = vi.fn();
  fixture.child.webContents.emit("will-navigate", { preventDefault });
  fixture.child.webContents.emit("will-attach-webview", { preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(native.handle).toHaveBeenCalledWith(PREVIEW_SESSION_STACK_CHANNEL, expect.any(Function));
});
