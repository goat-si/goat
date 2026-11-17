import type { PendingProcessEvent, TerminalSessionState } from "./Manager.ts";

/**
 * One line in the terminal itself, in the form of GOAT's other terminal notices: a shell keeps the
 * directory it started in, so after GOAT replaces the folder it still works in the old one.
 */
export const folderReplacedNotice = (folder: string) =>
  `\r\n[GOAT] ${folder} was restored or set aside, and this shell still works in the old folder. Run cd "${folder}" or open a new terminal.\r\n`;

/** Whether cwd is folder or inside it, by either separator. */
export const isInsideFolder = (folder: string, cwd: string) => {
  const root = folder.replace(/[\\/]+$/u, "");
  return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
};

export function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}
