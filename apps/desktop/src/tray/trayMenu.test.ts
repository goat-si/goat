import type { DesktopTrayThread } from "./trayMenu.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import { trayLabel, trayMenuTemplate, type TrayMenuInput } from "./trayMenu.ts";

const thread = (threadId: string, title = threadId): DesktopTrayThread => ({
  environmentId: "local",
  threadId,
  title,
  project: "goat",
});

const noop = { openApp: () => {}, newThread: () => {}, openThread: () => {}, quit: () => {} };
const click = (item: Electron.MenuItemConstructorOptions | undefined) =>
  item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

const template = (input: Partial<TrayMenuInput> & Pick<TrayMenuInput, "menu">) =>
  trayMenuTemplate({
    platform: "linux",
    appName: "GOAT",
    nativeHeaders: false,
    actions: noop,
    ...input,
  });

describe("trayMenuTemplate", () => {
  it("shows only the sections that have threads, after Open and New Thread and before Quit", () => {
    const items = template({
      menu: { attention: [], running: [thread("a")], pinned: [thread("b")] },
    });
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      "Open GOAT",
      "New Thread",
      "separator",
      "Running",
      "a",
      "separator",
      "Pinned",
      "b",
      "separator",
      "Quit GOAT",
    ]);
  });

  it("starts a new thread from its item", () => {
    const newThread = vi.fn();
    const items = template({
      menu: { attention: [], running: [], pinned: [] },
      actions: { ...noop, newThread },
    });
    click(items.find((item) => item.label === "New Thread"));
    expect(newThread).toHaveBeenCalledOnce();
  });

  it("moves rows past the fifth into More and opens the picked thread", () => {
    const openThread = vi.fn();
    const running = Array.from({ length: 7 }, (_, index) => thread(`t${index}`));
    const items = template({
      menu: { attention: [], running, pinned: [] },
      platform: "win32",
      actions: { ...noop, openThread },
    });
    const more = items.find((item) => item.label === "More");
    const overflow = Array.isArray(more?.submenu) ? more.submenu : [];
    expect(overflow.map((item) => item.label)).toEqual(["t5", "t6"]);
    click(overflow[1]);
    expect(openThread).toHaveBeenCalledWith(running[6]);
  });

  it("uses native section headers and project sublabels on macOS only", () => {
    const menu = { attention: [thread("a")], running: [], pinned: [] };
    const mac = template({ menu, platform: "darwin", nativeHeaders: true });
    const linux = template({ menu });
    expect(mac.find((item) => item.label === "Needs attention")?.type).toBe("header");
    expect(linux.find((item) => item.label === "Needs attention")).toMatchObject({
      enabled: false,
    });
    expect(mac.find((item) => item.label === "a")?.sublabel).toBe("goat");
    expect(linux.find((item) => item.label === "a")?.sublabel).toBeUndefined();
  });
});

describe("trayLabel", () => {
  it("shortens long titles and keeps ampersands literal", () => {
    const long = "Refactor the provider adapter registry & its tests for every runtime";
    expect(trayLabel(long)).toBe("Refactor the provider adapter registry…");
    expect(trayLabel("Fix A & B")).toBe("Fix A && B");
    expect(trayLabel("   ")).toBe("Untitled thread");
  });
});
