import { describe, expect, it } from "vite-plus/test";
import { describeThreadWorkspaceRecovery } from "./worktreeRetention.ts";

const at = {
  worktreePath: "/Users/me/src/feature",
  branch: "feature",
} as const;

describe("describeThreadWorkspaceRecovery", () => {
  it.each([
    [
      "missing",
      undefined,
      "Recreate rebuilds it from feature. Sending a message does the same.",
      true,
    ],
    ["missing", true, "Recreate rebuilds it from feature. Sending a message does the same.", true],
    [
      "missing",
      false,
      "GOAT can't recreate it: it is outside GOAT's worktrees folder. Put the folder back at /Users/me/src/feature, or start in a new worktree.",
      false,
    ],
    [
      "cleaned",
      undefined,
      "Restore brings back its files from the snapshot taken before cleanup. Sending a message restores it too.",
      true,
    ],
    [
      "cleaned",
      false,
      "GOAT can't restore it: it is outside GOAT's worktrees folder. Put the folder back at /Users/me/src/feature, or start in a new worktree.",
      false,
    ],
  ] as const)(
    "offers for a %s worktree with recreatable %s only what the server will do",
    (state, recreatable, body, inPlace) => {
      expect(
        describeThreadWorkspaceRecovery({
          ...at,
          state,
          ...(recreatable === undefined ? {} : { recreatable }),
        }),
      ).toEqual({ body, inPlace });
    },
  );
});
