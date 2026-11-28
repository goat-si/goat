import * as Effect from "effect/Effect";
import type { ShellSnapshotOptions } from "../ProjectionStore.ts";

/** True when a shell read names the threads, project, worktree or family it needs. */
export const isBoundedShellRead = (options: ShellSnapshotOptions | undefined) =>
  options?.threadIds !== undefined ||
  options?.projectId !== undefined ||
  options?.worktreePath !== undefined ||
  options?.familyOf !== undefined;

/**
 * Makes a service's shell reads die unless bounded. A real install's full snapshot holds thousands
 * of threads and stalls the server for seconds, so callers after a few threads must filter.
 */
export const refuseFullShellSnapshot = <
  S extends {
    readonly getShellSnapshot: (
      options?: ShellSnapshotOptions,
    ) => Effect.Effect<unknown, unknown, never>;
  },
>(
  service: S,
): S => ({
  ...service,
  getShellSnapshot: ((options?: ShellSnapshotOptions) =>
    isBoundedShellRead(options)
      ? service.getShellSnapshot(options)
      : Effect.die(
          new Error("A bounded lookup read the full shell snapshot"),
        )) as S["getShellSnapshot"],
});
