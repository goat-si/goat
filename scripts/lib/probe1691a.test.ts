import { assert, it } from "@effect/vitest";

// Throwaway probe for #1691 (do not merge): fails only on run attempt 1.
it("passes except on run attempt 1", () => {
  assert.notStrictEqual(process.env["GITHUB_RUN_ATTEMPT"], "1");
});
