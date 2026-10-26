import { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { DraftThreadEnvMode } from "~/composerDraftStore";

export const DraftSshDestinationSchema = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1)),
  environmentId: EnvironmentId,
});
export type DraftSshDestination = typeof DraftSshDestinationSchema.Type;
const isDraftSshDestination = Schema.is(DraftSshDestinationSchema);

/** A persisted destination that no longer decodes stays pinned, as an unavailable connection. */
export function normalizePersistedSshDestination(
  rawSshDestination: unknown,
  environmentId: EnvironmentId,
): DraftSshDestination | null {
  return rawSshDestination == null
    ? null
    : isDraftSshDestination(rawSshDestination)
      ? rawSshDestination
      : { connectionId: "unavailable", environmentId };
}

export function draftWorkspaceEdited(
  options:
    | {
        readonly envMode?: unknown;
        readonly branch?: unknown;
        readonly worktreePath?: unknown;
        readonly startFromOrigin?: unknown;
      }
    | undefined,
): boolean {
  return (
    options?.envMode !== undefined ||
    options?.branch !== undefined ||
    options?.worktreePath !== undefined ||
    options?.startFromOrigin !== undefined
  );
}

export function resolveDraftSshDestination(input: {
  previous: DraftSshDestination | null | undefined;
  requested: DraftSshDestination | null | undefined;
  projectChanged: boolean;
  workspaceEdited: boolean;
  envMode: DraftThreadEnvMode;
  worktreePath: string | null;
  startFromOrigin: boolean;
}): DraftSshDestination | null {
  const candidate =
    input.requested !== undefined
      ? input.requested
      : input.projectChanged || input.workspaceEdited
        ? null
        : (input.previous ?? null);
  return input.envMode === "worktree" && input.worktreePath === null && !input.startFromOrigin
    ? candidate
    : null;
}
export function draftSshDestinationsEqual(
  left: DraftSshDestination | null | undefined,
  right: DraftSshDestination | null | undefined,
): boolean {
  return left == null || right == null
    ? left == null && right == null
    : left.connectionId === right.connectionId && left.environmentId === right.environmentId;
}
