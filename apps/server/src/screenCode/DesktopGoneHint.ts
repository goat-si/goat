import type { ScreenRunError } from "@goat/contracts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
import type { WindowEntry } from "./DesktopWindows.ts";

export const goneHint = (
  error: ScreenRunError,
  bound: BoundWindow,
  windows: ReadonlyArray<WindowEntry> | undefined,
) => {
  if (error.detail !== "window_gone" || bound.bundleId === undefined) return error;
  windows = windows?.filter((window) => window.window_id !== bound.windowId);
  if (!windows?.length) return error;
  const prefix = "That window is closed. Windows seen open in this cell: ";
  const choices: string[] = [];
  for (const window of windows) {
    const choice = `window_id: ${window.window_id}, title: ${JSON.stringify(window.title)}${window.sheetOf === undefined ? "" : `, sheet parent: ${window.sheetOf}`}${window.pid === bound.pid ? "" : `, another process (pid ${window.pid})`}: screen.app({ bundle_id: ${JSON.stringify(bound.bundleId)}, window_id: ${window.window_id} })`;
    if (
      `${prefix}${[...choices, choice].join("; ")}. More windows: screen.discover().`.length > 1024
    )
      break;
    choices.push(choice);
  }
  if (!choices.length) return error;
  return {
    ...error,
    nextStep: `${prefix}${choices.join("; ")}.${choices.length < windows.length ? " More windows: screen.discover()." : ""}`,
  };
};
