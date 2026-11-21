import { expect, it } from "vite-plus/test";
import { normalizeComposerPathSearchQuery } from "./queryTargets";

it("distinguishes an inactive trigger from a bare @ query", () => {
  expect(normalizeComposerPathSearchQuery(null)).toBeNull();
  expect(normalizeComposerPathSearchQuery("")).toBe("");
});
