import type { DesktopTrayThread } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { trayLabel, trayMenuTemplate } from "./trayMenu.ts";

const thread = (threadId: string, title = threadId): DesktopTrayThread => ({
  environmentId: "local",
  threadId,
  title,
  project: "goat",
});

const noop = { openApp: () => {}, openThread: () => {}, quit: () => {} };

describe("trayMenuTemplate", () => {
  it("shows only the sections that have threads, between Open and Quit", () => {
    const template = trayMenuTemplate({
      menu: { attention: [], running: [thread("a")], pinned: [thread("b")] },
      platform: "darwin",
      appName: "GOAT",
      actions: noop,
    });
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "Open GOAT",
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

  it("moves rows past the fifth into More and opens the picked thread", () => {
    const openThread = vi.fn();
    const running = Array.from({ length: 7 }, (_, index) => thread(`t${index}`));
    const template = trayMenuTemplate({
      menu: { attention: [], running, pinned: [] },
      platform: "win32",
      appName: "GOAT",
      actions: { ...noop, openThread },
    });
    const more = template.find((item) => item.label === "More");
    const overflow = Array.isArray(more?.submenu) ? more.submenu : [];
    expect(overflow.map((item) => item.label)).toEqual(["t5", "t6"]);
    overflow[1]?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(openThread).toHaveBeenCalledWith(running[6]);
  });

  it("draws the project as a sublabel only on macOS", () => {
    const menu = { attention: [thread("a")], running: [], pinned: [] };
    const mac = trayMenuTemplate({ menu, platform: "darwin", appName: "GOAT", actions: noop });
    const linux = trayMenuTemplate({ menu, platform: "linux", appName: "GOAT", actions: noop });
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
