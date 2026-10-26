import { ipcRenderer } from "electron";

import { RECORDING_POINTER_CHANNEL } from "./GuestProtocol.ts";

function isTerminalAgentCursor(point: unknown): boolean {
  return (
    typeof point === "object" &&
    point !== null &&
    "type" in point &&
    point.type === "cursor-state" &&
    "cursor" in point &&
    typeof point.cursor === "object" &&
    point.cursor !== null &&
    "phase" in point.cursor &&
    (point.cursor.phase === "hidden" || point.cursor.phase === "yielded")
  );
}

/**
 * Hides the drawn agent cursor when its owner reports a hidden or yielded phase, until the
 * returned function removes the listener. The preload's pointer listener ignores these frames:
 * they carry no point.
 */
export function onTerminalAgentCursor(hideAgent: () => void): () => void {
  const listener = (_event: unknown, point: unknown) => {
    if (isTerminalAgentCursor(point)) hideAgent();
  };
  ipcRenderer.on(RECORDING_POINTER_CHANNEL, listener);
  return () => {
    ipcRenderer.removeListener(RECORDING_POINTER_CHANNEL, listener);
  };
}
