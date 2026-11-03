import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BrowserOrigin, BrowserClaimsSnapshot } from "./browserClaims.ts";
import { BrowserClaimsPersonSnapshot } from "./browserClaimsRpc.ts";

const decodeClaimsSnapshot = Schema.decodeUnknownSync(BrowserClaimsSnapshot);

describe("BrowserOrigin", () => {
  it("accepts only canonical HTTP origins without credentials, paths, queries or fragments", () => {
    const decode = Schema.decodeUnknownSync(BrowserOrigin);
    for (const origin of ["https://example.test", "http://localhost:3000", "https://[::1]:444"])
      expect(decode(origin)).toBe(origin);
    for (const origin of [
      "https://example.test/",
      "https://EXAMPLE.test",
      "https://example.test:443",
      "https://user@example.test",
      "https://example.test/path",
      "https://example.test?q=1",
      "https://example.test#x",
      "file:///tmp/x",
      "about:blank",
    ])
      expect(() => decode(origin), origin).toThrow();
  });
});

it("keeps blocked claim endings in the agent-facing snapshot", () => {
  const snapshot = {
    claims: [],
    grants: [],
    ended: [{ claimId: "claim-1", reason: "blocked_url" }],
  };
  expect(decodeClaimsSnapshot(snapshot)).toEqual(snapshot);
});

it("accepts person claim snapshots from servers with and without a window title", () => {
  const decode = Schema.decodeUnknownSync(BrowserClaimsPersonSnapshot);
  const claim = {
    claimId: "claim-1",
    environmentId: "env-1",
    threadId: "thread-1",
    tab: { pid: 1, windowId: 2, tabId: "tab-1" },
    title: "Tab title",
    origin: "https://example.test",
    driverGeneration: 1,
    claimGeneration: 1,
    status: "attached",
  };
  for (const item of [claim, { ...claim, windowTitle: "Window title" }]) {
    expect(decode({ claims: [item], grants: [], pending: [] }).claims[0]).toEqual(item);
  }
});
