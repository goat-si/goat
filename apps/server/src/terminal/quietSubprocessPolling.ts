import type * as PtyAdapter from "@goat/shared/PtyAdapter";

// Discover children started without terminal input or output.
const QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS = 30;
// Bounds how late a steady command's silent exit or new child is seen.
const STEADY_SUBPROCESS_SNAPSHOT_EVERY_TICKS = 5;

export interface QuietTerminalSession {
  readonly process: PtyAdapter.PtyProcess | null;
  readonly mark: number;
  readonly processKey: string | null;
  readonly idleSnapshots: number;
}

export function quietSnapshotEveryTicks(
  quiet: QuietTerminalSession | undefined,
  process: PtyAdapter.PtyProcess | null,
  mark: number,
): number {
  if (
    quiet === undefined ||
    quiet.idleSnapshots < 2 ||
    quiet.process !== process ||
    quiet.mark !== mark
  ) {
    return 1;
  }
  return quiet.processKey === null
    ? QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS
    : STEADY_SUBPROCESS_SNAPSHOT_EVERY_TICKS;
}
