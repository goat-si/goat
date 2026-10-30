import { expect, it } from "vite-plus/test";
import { addBlockedBrowserHost, removeBlockedBrowserHost } from "./blockedBrowserHosts.ts";

it("normalizes additions and removes the selected host", () => {
  expect(addBlockedBrowserHost(["existing.test"], " Example.COM. ")).toEqual({
    ok: true,
    hosts: ["existing.test", "example.com"],
  });
  expect(addBlockedBrowserHost(["example.com"], "EXAMPLE.COM")).toEqual({
    ok: true,
    hosts: ["example.com"],
  });
  expect(removeBlockedBrowserHost(["one.test", "two.test"], "one.test")).toEqual(["two.test"]);
});

it("reports contract validation failures without changing the existing list", () => {
  const result = addBlockedBrowserHost(["existing.test"], "https://example.com/path");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
});
