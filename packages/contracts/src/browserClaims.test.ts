import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BrowserOrigin } from "./browserClaims.ts";

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
