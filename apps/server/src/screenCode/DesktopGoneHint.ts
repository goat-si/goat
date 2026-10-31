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
  const choices = windows.map(
    (window) =>
      `window_id: ${window.window_id}, title: ${JSON.stringify(window.title)}${window.sheetOf === undefined ? "" : `, sheet parent: ${window.sheetOf}`}${window.pid === bound.pid ? "" : `, another process (pid ${window.pid})`}: screen.app({ bundle_id: ${JSON.stringify(bound.bundleId)}, window_id: ${window.window_id} })`,
  );
  return {
    ...error,
    nextStep: `That window is closed. Windows seen open in this cell: ${choices.join("; ")}.`,
  };
};
