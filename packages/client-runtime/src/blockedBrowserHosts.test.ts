import { expect, it } from "vite-plus/test";
import {
  addBlockedBrowserHost,
  INVALID_BLOCKED_HOST,
  removeBlockedBrowserHost,
} from "./blockedBrowserHosts.ts";

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

it("explains a rejected entry in words a person can act on", () => {
  expect(addBlockedBrowserHost(["existing.test"], "https://example.com/path")).toEqual({
    ok: false,
    error: INVALID_BLOCKED_HOST,
  });
});
