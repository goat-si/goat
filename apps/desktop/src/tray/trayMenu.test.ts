import type { DesktopTrayMenu, DesktopTrayThread } from "./trayMenu.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import { trayLabel, trayMenuTemplate, type TrayMenuInput } from "./trayMenu.ts";

const thread = (threadId: string, title = threadId): DesktopTrayThread => ({
  environmentId: "local",
  threadId,
  title,
  project: "goat",
});

const noop = {
  openApp: () => {},
  newThread: () => {},
  openThread: () => {},
  quit: () => {},
  stopComputerUse: () => {},
  stopAllComputerUse: () => {},
};
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

const held = (
  computerUse: NonNullable<DesktopTrayMenu["computerUse"]> | null,
): DesktopTrayMenu => ({
  attention: [],
  running: [],
  pinned: [],
  computerUse,
});

const stopped = (
  appId: string | null,
  name: string,
  threadCount: number,
): NonNullable<DesktopTrayMenu["computerUse"]>["targets"][number] => ({
  appId,
  name,
  icon: null,
  threadCount,
});

const submenu = (items: readonly Electron.MenuItemConstructorOptions[]) =>
  Array.isArray(items[0]?.submenu) ? items[0].submenu : [];

const holders: NonNullable<DesktopTrayMenu["computerUse"]> = {
  threadCount: 3,
  appCount: 2,
  targets: [
    stopped("com.apple.calculator", "Calculator", 1),
    stopped("com.kakao.KakaoTalk", "KakaoTalk", 2),
    stopped(null, "Screen", 1),
  ],
};

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

  it("keeps Open GOAT first when computer use is absent or null", () => {
    expect(template({ menu: { attention: [], running: [], pinned: [] } })[0]?.label).toBe(
      "Open GOAT",
    );
    expect(template({ menu: held(null) })[0]?.label).toBe("Open GOAT");
  });

  it("lists every holder under Computer Use before Open GOAT", () => {
    const items = template({ menu: held(holders) });
    expect(items[0]?.label).toBe("Computer Use · 3 threads · 2 apps");
    expect(submenu(items).map((item) => item.label ?? item.type)).toEqual([
      "Stop Using Calculator",
      "Stop Using KakaoTalk (2 threads)",
      "Stop Using the Screen",
      "separator",
      "Stop All Computer Use",
    ]);
    expect(items[1]?.type).toBe("separator");
    expect(items[2]?.label).toBe("Open GOAT");
  });

  it("names the whole screen when that is the only target", () => {
    const items = template({
      menu: held({
        threadCount: 1,
        appCount: 0,
        targets: [stopped(null, "Screen", 1)],
      }),
    });
    expect(items[0]?.label).toBe("Computer Use · 1 thread · whole screen");
  });

  it("disables a row for the apps past the twelve listed", () => {
    const items = template({
      menu: held({
        threadCount: 13,
        appCount: 13,
        targets: Array.from({ length: 12 }, (_, index) =>
          stopped(`app.${index}`, `App ${index}`, 1),
        ),
      }),
    });
    const entries = submenu(items);
    const labels = entries.map((item) => item.label ?? item.type);
    const more = labels.indexOf("1 more app, use Stop All");
    expect(entries[more]).toMatchObject({ enabled: false });
    expect(labels[more + 1]).toBe("separator");
  });

  it("stops the picked app, the screen, or every computer-use session", () => {
    const stopComputerUse = vi.fn();
    const stopAllComputerUse = vi.fn();
    const entries = submenu(
      template({
        menu: held(holders),
        actions: { ...noop, stopComputerUse, stopAllComputerUse },
      }),
    );
    click(entries.find((item) => item.label === "Stop Using KakaoTalk (2 threads)"));
    click(entries.find((item) => item.label === "Stop Using the Screen"));
    click(entries.find((item) => item.label === "Stop All Computer Use"));
    expect(stopComputerUse).toHaveBeenNthCalledWith(1, "com.kakao.KakaoTalk");
    expect(stopComputerUse).toHaveBeenNthCalledWith(2, null);
    expect(stopAllComputerUse).toHaveBeenCalledOnce();
  });

  it("escapes an ampersand in a Computer Use stop label", () => {
    const entries = submenu(
      template({
        menu: held({
          threadCount: 1,
          appCount: 1,
          targets: [stopped("com.example.rd", "R&D Tool", 1)],
        }),
      }),
    );
    expect(entries[0]?.label).toBe("Stop Using R&&D Tool");
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
