import { expect, it } from "vite-plus/test";
import { findRevertCheckpoint } from "./sessionRevert";

it("allows conversation rewind to a failed checkpoint but excludes stale checkpoints", () => {
  const checkpoint = { status: "error", appRunOrdinal: 1, ordinalWithinScope: 1 } as Parameters<
    typeof findRevertCheckpoint
  >[0][number];
  expect(findRevertCheckpoint([checkpoint], 1)).toBe(checkpoint);
  expect(findRevertCheckpoint([{ ...checkpoint, status: "stale" }], 1)).toBeUndefined();
});
