import { expect, it } from "vitest";

// Throwaway probe for #1691 (do not merge): fails only on run attempt 1.
it("passes except on run attempt 1", () => {
  expect(process.env.GITHUB_RUN_ATTEMPT).not.toBe("1");
});

