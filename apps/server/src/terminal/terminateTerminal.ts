import type * as PtyAdapter from "@goat/shared/PtyAdapter";

export function terminateTerminal(process: PtyAdapter.PtyProcess, platform: NodeJS.Platform) {
  if (platform !== "win32") {
    try {
      process.kill("SIGHUP");
    } catch {
      // SIGTERM reports a shell that can no longer be signalled.
    }
  }
  return process.kill("SIGTERM");
}
