export const inProgressHeads = [
  { head: "MERGE_HEAD", operation: "merge" },
  { head: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { head: "REVERT_HEAD", operation: "revert" },
  { head: "sequencer", operation: "cherry-pick or revert" },
] as const;
