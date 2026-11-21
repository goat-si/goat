import { expect, it } from "vite-plus/test";
import { worktreeSetupPresentation } from "./worktree-setup-state";

it("keeps a setup anchor before and during the first snapshot", () => {
  expect(worktreeSetupPresentation({ hasSetup: false, preparing: true })).toBe("preparing");
  expect(worktreeSetupPresentation({ hasSetup: true, preparing: true })).toBe("setup");
  expect(worktreeSetupPresentation({ hasSetup: false, preparing: false })).toBe("none");
});
