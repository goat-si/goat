import { assert, describe, it } from "@effect/vitest";

import { selectWorktreeInstall } from "./setup-worktree.ts";

describe("selectWorktreeInstall", () => {
  it("prefers vp, then pnpm, then npx vite-plus, without the --yes pnpm 12 can reject (#1001)", () => {
    assert.deepEqual(selectWorktreeInstall({ vp: true, pnpm: true }), {
      command: "vp i --frozen-lockfile",
      tool: "vp",
    });
    assert.deepEqual(selectWorktreeInstall({ vp: false, pnpm: true }), {
      command: "pnpm install --frozen-lockfile",
      tool: "pnpm",
    });
    assert.deepEqual(selectWorktreeInstall({ vp: false, pnpm: false }), {
      command: "npx --yes vite-plus i --frozen-lockfile",
      tool: "npx vite-plus",
    });
  });
});
