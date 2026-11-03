import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BrowserOrigin } from "./browserClaims.ts";
import { ComputerUseLeaseReport } from "./cua.ts";

it("bounds the URLs carried by browser claim reply reports", () => {
  const decode = Schema.decodeUnknownSync(ComputerUseLeaseReport);
  const report = {
    browserClaimReply: {
      claimId: "claim-1",
      claimGeneration: 1,
      urls: ["https://example.test"],
      outside: true,
    },
  };
  expect(decode(report)).toEqual(report);
  expect(() =>
    decode({
      browserClaimReply: {
        ...report.browserClaimReply,
        urls: Array(17).fill("https://example.test"),
      },
    }),
  ).toThrow();
  expect(() =>
    decode({ browserClaimReply: { ...report.browserClaimReply, urls: ["a".repeat(8193)] } }),
  ).toThrow();
});

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
