import { expect, it, vi } from "vite-plus/test";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { settleInitialOpen, unloadedOpen } from "./unloadedOpen.ts";

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

it("closes failed hidden tabs but keeps recoverable network errors and downloads", async () => {
  const close = vi.fn(async () => {});
  const timeout = Object.assign(new Error("net::ERR_TIMED_OUT"), { name: "TimeoutError" });
  await expect(settleInitialOpen(Promise.reject(timeout), "tab-1", close)).rejects.toBe(timeout);
  expect(close).toHaveBeenCalledTimes(1);
  const network = new Error("net::ERR_CONNECTION_REFUSED");
  await expect(settleInitialOpen(Promise.reject(network), "tab-2", close)).rejects.toMatchObject({
    detail: { openedTabId: "tab-2" },
  });
  const download = new Error("Download is starting");
  await expect(settleInitialOpen(Promise.reject(download), "tab-3", close)).rejects.toBe(download);
  expect(close).toHaveBeenCalledTimes(1);
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
