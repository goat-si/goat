import * as Effect from "effect/Effect";
import type { ShellSnapshotOptions } from "../ProjectionStore.ts";

/** True when a shell read names the threads, project, worktree or family it needs. */
const isBoundedShellRead = (options: ShellSnapshotOptions | undefined) =>
  options?.threadIds !== undefined ||
  options?.projectId !== undefined ||
  options?.worktreePath !== undefined ||
  options?.familyOf !== undefined;

/**
 * Makes shell reads die unless bounded. A real install's full snapshot holds thousands of threads
 * and stalls the server for seconds, so callers after a few threads must filter.
 */
export const refuseFullShellSnapshot =
  <A, E>(read: (options?: ShellSnapshotOptions) => Effect.Effect<A, E>) =>
  (options?: ShellSnapshotOptions): Effect.Effect<A, E> =>
    isBoundedShellRead(options)
      ? read(options)
      : Effect.die(new Error("A bounded lookup read the full shell snapshot"));
