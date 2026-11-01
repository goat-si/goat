import { expect, it } from "vite-plus/test";
import { toOperationError } from "./ServerBrowserPage.ts";

it("retains a bounded pointer blocker description without its attributes or text", () => {
  const cause = new Error(
    'click timed out\n - <div role="dialog" data-token="private-token">private-value</div> intercepts pointer events\n',
  );
  cause.name = "TimeoutError";
  const error = toOperationError(cause, 15000);
  expect(error.detail).toEqual({
    timeoutMs: 15000,
    interceptedBy: "Pointer intercepted by <div> (dialog).",
  });
  expect(JSON.stringify(error.detail)).not.toContain("private");
});
