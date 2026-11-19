import { expect, it } from "vite-plus/test";
import { worktreeSetupPresentation } from "./worktree-setup-state";

it("keeps a setup anchor before and during the first snapshot", () => {
  expect(worktreeSetupPresentation({ hasSetup: false, working: false, preparing: true })).toBe(
    "preparing",
  );
  expect(worktreeSetupPresentation({ hasSetup: true, working: false, preparing: true })).toBe(
    "setup",
  );
  expect(worktreeSetupPresentation({ hasSetup: false, working: true, preparing: false })).toBe(
    "working",
  );
  expect(worktreeSetupPresentation({ hasSetup: false, working: false, preparing: false })).toBe(
    "none",
  );
});
