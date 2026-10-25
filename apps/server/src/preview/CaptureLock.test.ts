import { expect, it } from "vite-plus/test";

import { withCaptureLock } from "./CaptureLock.ts";

it("a capture whose deadline passed while it waited never runs, even before its timer fires", async () => {
  const tab = { captureLock: Promise.resolve(), closing: false };
  let ran = false;
  // Its turn comes on the next microtask, before any timer could mark it expired.
  const late = withCaptureLock(
    tab,
    async () => {
      ran = true;
    },
    performance.now() - 1,
  );
  await expect(late).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
  await tab.captureLock;
  expect(ran).toBe(false);
});
