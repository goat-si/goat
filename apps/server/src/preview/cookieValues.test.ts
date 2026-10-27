import { describe, expect, it } from "vite-plus/test";

import { REDACTED, redactCookieValues } from "./cookieValues.ts";

describe("redactCookieValues", () => {
  it("redacts a cookie's value even when the cookie has no name", () => {
    expect(
      redactCookieValues("token UNNAMED_SECRET_123456 here", [
        { name: "", value: "UNNAMED_SECRET_123456" },
      ]),
    ).toBe(`token ${REDACTED} here`);
  });

  it("keeps the rules for short values and name=value pairs", () => {
    const cookies = [
      { name: "lang", value: "en" },
      { name: "sid", value: "ab12" },
      { name: "session", value: "LongValue123" },
    ];
    expect(redactCookieValues("lang=en English ab12 ab123 sid=ab12 x LongValue123x", cookies)).toBe(
      `lang=${REDACTED} English ${REDACTED} ab123 sid=${REDACTED} x ${REDACTED}x`,
    );
  });

  it("handles thousands of long cookie values without building a pattern from them", () => {
    const cookies = Array.from({ length: 3_000 }, (_, index) => ({
      name: `c${index}`,
      value: `${index.toString(36).padStart(4, "0")}${"v".repeat(4_000)}`,
    }));
    const text = `start ${cookies[1_234]!.value} end`;
    expect(redactCookieValues(text, cookies)).toBe(`start ${REDACTED} end`);
  });
});
