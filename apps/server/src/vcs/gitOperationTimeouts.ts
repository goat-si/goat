import * as Duration from "effect/Duration";

// Silence, not total time, marks a stuck checkout: a Windows checkout under real-time
// scanning or a hook installing dependencies can print steadily for many minutes.
export const WORKTREE_ADD_STALL_TIMEOUT_MS = Duration.toMillis(Duration.minutes(2));
// The first fetch after a long gap can pull thousands of new refs for minutes while
// printing progress the whole time, so the worktree base fetch also stops only on silence.
export const WORKTREE_BASE_FETCH_STALL_TIMEOUT_MS = Duration.toMillis(Duration.minutes(2));
export const FETCH_REMOTE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));
export const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));
