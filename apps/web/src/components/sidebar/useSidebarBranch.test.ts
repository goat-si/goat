import { describe, expect, it } from "vite-plus/test";
import { VcsBranchStatus } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { withoutRemovedCheckout } from "./useSidebarBranch";

describe("sidebar checkout labels", () => {
  const thread = { branch: "topic", worktreePath: "/worktrees/topic" };
  const decode = Schema.decodeUnknownSync(VcsBranchStatus);

  it("keeps persisted labels when HEAD is detached or the host sends only refName", () => {
    expect(withoutRemovedCheckout(thread, decode({ refName: null }))).toBe(thread);
    expect(withoutRemovedCheckout(thread, decode({ refName: null, isRepo: true }))).toBe(thread);
    expect(withoutRemovedCheckout(thread, null)).toBe(thread);
  });

  it("clears both labels for a removed checkout without editing the thread", () => {
    expect(withoutRemovedCheckout(thread, decode({ refName: null, isRepo: false }))).toEqual({
      branch: null,
      worktreePath: null,
    });
    expect(thread).toEqual({ branch: "topic", worktreePath: "/worktrees/topic" });
  });
});
