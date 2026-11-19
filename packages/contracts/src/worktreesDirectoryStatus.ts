import * as Schema from "effect/Schema";

export const WorktreesDirectoryUnavailableReason = Schema.Literals([
  "invalid",
  "unmounted",
  "missing",
  "not-a-directory",
  "not-writable",
]);
export type WorktreesDirectoryUnavailableReason = typeof WorktreesDirectoryUnavailableReason.Type;

/**
 * Where this server creates new worktrees right now. `unavailable` is set
 * when a custom location is configured but cannot be used, in which case
 * `directory` is the default `<GOAT home>/worktrees` fallback.
 */
export const WorktreesDirectoryStatus = Schema.Struct({
  configured: Schema.String,
  directory: Schema.String,
  unavailable: Schema.NullOr(
    Schema.Struct({
      reason: WorktreesDirectoryUnavailableReason,
      /** The resolved configured path, or null when the setting is not a usable absolute path. */
      path: Schema.NullOr(Schema.String),
    }),
  ),
});
export type WorktreesDirectoryStatus = typeof WorktreesDirectoryStatus.Type;

export function describeWorktreesDirectoryUnavailable(
  reason: WorktreesDirectoryUnavailableReason,
): string {
  switch (reason) {
    case "invalid":
      return "is not an absolute folder on this machine";
    case "unmounted":
      return "is on a drive that is not connected";
    case "missing":
      return "does not exist and its parent folder is missing";
    case "not-a-directory":
      return "is not a folder";
    case "not-writable":
      return "is not writable";
  }
}
