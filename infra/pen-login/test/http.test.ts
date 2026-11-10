import { describe, expect, it } from "vite-plus/test";
import { sourceKey } from "../src/http.ts";

describe("rate-limit sources (Accounts v1.1: keyed by IPv4 address or IPv6 /64)", () => {
  it("an IPv4 address is its own key, and every address in one IPv6 /64 shares one key", () => {
    expect(sourceKey("198.51.100.7")).toBe("198.51.100.7");
    expect(sourceKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:0db8:0001:0002::9")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceKey("2001:db8:1:3::1")).not.toBe(sourceKey("2001:db8:1:2::1"));
    expect(sourceKey(null)).toBe("unknown");
  });
});
