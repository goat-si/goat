import { expect, it } from "vite-plus/test";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { unloadedOpen } from "./unloadedOpen.ts";

it("names the tab and network error of an open whose page never connected", () => {
  const cause = new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
  );
  expect(unloadedOpen("tab-1", cause)).toMatchObject({
    tag: "PreviewAutomationExecutionError",
    detail: { openedTabId: "tab-1", loadError: "ERR_CONNECTION_REFUSED" },
  });
  // Chromium error names can carry digits.
  const tls = new Error("page.goto: net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH2 at https://x.test/");
  expect(unloadedOpen("tab-2", tls)).toMatchObject({
    detail: { loadError: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH2" },
  });
});

it("passes a timeout or a failure without a network error through unchanged", () => {
  const timeout = new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "page.goto: net::ERR_TIMED_OUT; Timeout 15000ms exceeded.",
  );
  expect(unloadedOpen("tab-1", timeout)).toBe(timeout);
  const other = new Error("Target page, context or browser has been closed");
  expect(unloadedOpen("tab-1", other)).toBe(other);
});
