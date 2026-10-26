import type { DesktopTrayMenu, DesktopTrayThread } from "@goat/contracts";
import type * as Electron from "electron";

const SECTION_ROWS = 5;
const TITLE_CODE_POINTS = 40;

export interface TrayMenuActions {
  readonly openApp: () => void;
  readonly openThread: (thread: DesktopTrayThread) => void;
  readonly quit: () => void;
}

export interface TrayMenuInput {
  readonly menu: DesktopTrayMenu;
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly actions: TrayMenuActions;
}

// Windows and Linux read "&" as a mnemonic marker; "&&" draws one ampersand.
export function trayLabel(text: string, platform: NodeJS.Platform): string {
  const codePoints = Array.from(text.replace(/\s+/g, " ").trim());
  const shortened =
    codePoints.length > TITLE_CODE_POINTS
      ? `${codePoints
          .slice(0, TITLE_CODE_POINTS - 1)
          .join("")
          .trimEnd()}…`
      : codePoints.join("");
  const label = shortened.length > 0 ? shortened : "Untitled thread";
  return platform === "darwin" ? label : label.replaceAll("&", "&&");
}

function threadItem(
  thread: DesktopTrayThread,
  { platform, actions }: TrayMenuInput,
): Electron.MenuItemConstructorOptions {
  return {
    label: trayLabel(thread.title, platform),
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
    { label: title, enabled: false },
    ...shown,
    ...(rest.length > 0 ? [{ label: "More", submenu: rest }] : []),
  ];
}

export function trayMenuTemplate(input: TrayMenuInput): Electron.MenuItemConstructorOptions[] {
  const { menu, platform, appName, actions } = input;
  const sections = [
    section("Needs attention", menu.attention, input),
    section("Running", menu.running, input),
    section("Pinned", menu.pinned, input),
  ].filter((items) => items.length > 0);
  return [
    { label: trayLabel(`Open ${appName}`, platform), click: actions.openApp },
    ...sections.flatMap((items) => [{ type: "separator" as const }, ...items]),
    { type: "separator" },
    { label: trayLabel(`Quit ${appName}`, platform), click: actions.quit },
  ];
}
