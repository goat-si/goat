import { expect, it } from "vite-plus/test";

import { scheduledMemoryAccess } from "./scheduledTaskPresentation";
it("keeps the saved ceiling separate from unknown current access", () => {
  expect(scheduledMemoryAccess({})).toBeNull();
  expect(scheduledMemoryAccess({ memoryGrantCeiling: "read_write" })).toBe(
    "Memory limit: read & write",
  );
});
