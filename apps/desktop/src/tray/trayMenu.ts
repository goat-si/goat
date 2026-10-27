import type { DesktopBridge } from "@goat/contracts";
import type * as Electron from "electron";

export type DesktopTrayMenu = Parameters<NonNullable<DesktopBridge["setTrayMenu"]>>[0];
export type DesktopTrayThread = DesktopTrayMenu["attention"][number];
export type DesktopTrayAction = Parameters<
  Parameters<NonNullable<DesktopBridge["onTrayAction"]>>[0]
>[0];

const SECTION_ROWS = 5;
const TITLE_CODE_POINTS = 40;

export interface TrayMenuActions {
  readonly openApp: () => void;
  readonly newThread: () => void;
  readonly openThread: (thread: DesktopTrayThread) => void;
  readonly quit: () => void;
  readonly stopComputerUse: (appId: string | null) => void;
  readonly stopAllComputerUse: () => void;
}

export interface TrayMenuInput {
  readonly menu: DesktopTrayMenu;
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  /** macOS 14+ draws NSMenu section headers; elsewhere a section title is a disabled row. */
  readonly nativeHeaders: boolean;
  readonly actions: TrayMenuActions;
}

// Electron reads "&" as a mnemonic marker on every platform (macOS drops it); "&&" draws one.
export function trayLabel(
  text: string,
  limit = TITLE_CODE_POINTS,
  fallback = "Untitled thread",
): string {
  const codePoints = Array.from(text.replace(/\s+/g, " ").trim());
  const shortened =
    codePoints.length > limit
      ? `${codePoints
          .slice(0, limit - 1)
          .join("")
          .trimEnd()}…`
      : codePoints.join("");
  return (shortened.length > 0 ? shortened : fallback).replaceAll("&", "&&");
}

function threadItem(
  thread: DesktopTrayThread,
  { platform, actions }: TrayMenuInput,
): Electron.MenuItemConstructorOptions {
  return {
    label: trayLabel(thread.title),
    // Only macOS 14.4+ draws sublabels on menu items.
    ...(platform === "darwin" && thread.project !== null ? { sublabel: thread.project } : {}),
    click: () => actions.openThread(thread),
  };
}

function section(
  title: string,
  threads: readonly DesktopTrayThread[],
  input: TrayMenuInput,
): Electron.MenuItemConstructorOptions[] {
  if (threads.length === 0) return [];
  const shown = threads.slice(0, SECTION_ROWS).map((thread) => threadItem(thread, input));
  const rest = threads.slice(SECTION_ROWS).map((thread) => threadItem(thread, input));
  return [
    input.nativeHeaders ? { type: "header", label: title } : { label: title, enabled: false },
    ...shown,
    ...(rest.length > 0 ? [{ label: "More", submenu: rest }] : []),
  ];
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function computerUseItems({ menu, actions }: TrayMenuInput): Electron.MenuItemConstructorOptions[] {
  const use = menu.computerUse;
  if (use == null || use.threadCount === 0) return [];
  const screen = use.targets.some((target) => target.appId === null);
  const parts = ["Computer Use", count(use.threadCount, "thread")];
  if (use.appCount > 0) parts.push(count(use.appCount, "app"));
  else if (screen) parts.push("whole screen");
  const rows = use.targets.map((target) => ({
    label:
      `Stop Using ${target.appId === null ? "the Screen" : trayLabel(target.name, 24, target.appId)}` +
      (target.threadCount > 1 ? ` (${target.threadCount} threads)` : ""),
    click: () => actions.stopComputerUse(target.appId),
  }));
  const hidden = use.appCount - use.targets.filter((target) => target.appId !== null).length;
  const more =
    hidden > 0 ? [{ label: `${count(hidden, "more app")}, use Stop All`, enabled: false }] : [];
  return [
    {
      label: parts.join(" · "),
      submenu: [
        ...rows,
        ...more,
        ...(rows.length + more.length > 0 ? [{ type: "separator" as const }] : []),
        { label: "Stop All Computer Use", click: actions.stopAllComputerUse },
      ],
    },
    { type: "separator" },
  ];
}

export function trayMenuTemplate(input: TrayMenuInput): Electron.MenuItemConstructorOptions[] {
  const { menu, appName, actions } = input;
  const sections = [
    section("Needs attention", menu.attention, input),
    section("Running", menu.running, input),
    section("Pinned", menu.pinned, input),
  ].filter((items) => items.length > 0);
  return [
    ...computerUseItems(input),
    { label: trayLabel(`Open ${appName}`), click: actions.openApp },
    { label: "New Thread", click: actions.newThread },
    ...sections.flatMap((items) => [{ type: "separator" as const }, ...items]),
    { type: "separator" },
    { label: trayLabel(`Quit ${appName}`), click: actions.quit },
  ];
}
