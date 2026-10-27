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
  it("redacts the start of a long value cut off at the end of a text, and nothing else", () => {
    const cookies = [{ name: "sid", value: "SessionSecret77" }];
    expect(redactCookieValues("x sid=SessionSec", cookies)).toBe(`x sid=${REDACTED}`);
    expect(redactCookieValues("Session is over", cookies)).toBe("Session is over");
  });
  it("redacts a value as JSON escapes it", () => {
    const cookies = [{ name: "sid", value: 'Secret"Value777' }];
    expect(redactCookieValues(JSON.stringify({ echo: 'sid=Secret"Value777' }), cookies)).toBe(
      `{"echo":"sid=${REDACTED}"}`,
    );
  });
  it("masks a long value whole even when a shorter one inside it falls in another batch", () => {
    const cookies = [
      // Sorted first by length, so its prefix ABCDEF lands in the first batch.
      { name: "first", value: `ABCDEF${"x".repeat(100)}` },
      ...Array.from({ length: 5_000 }, (_, index) => ({
        name: `c${index}`,
        value: `${index.toString(36).padStart(6, "0")}${"z".repeat(70)}`,
      })),
      { name: "short", value: "ABCDEF" },
      { name: "long", value: "TargetCredential-ABCDEF-Secret123456" },
    ];
    expect(redactCookieValues("log TargetCredential-ABCDEF-Secret123456 end", cookies)).toBe(
      `log ${REDACTED} end`,
    );
  });
  it("masks every kind of match against the original text, so no kind hides another", () => {
    // A full short match inside a value cut off at the end.
    expect(
      redactCookieValues("sid=SessionSecret77", [
        { name: "a", value: "Session" },
        { name: "b", value: "SessionSecret77AndMuchMore" },
      ]),
    ).toBe(`sid=${REDACTED}`);
    // A long value that is another cookie's name.
    expect(
      redactCookieValues("Session=ab", [
        { name: "other", value: "Session" },
        { name: "Session", value: "ab" },
      ]),
    ).toBe(`${REDACTED}=${REDACTED}`);
  });

  it("stays fast on thousands of near-identical long values", () => {
    const base = "a".repeat(3_980);
    const cookies = [
      ...Array.from({ length: 3_000 }, (_, index) => ({
        name: `c${index}`,
        value: `${base}${index.toString(36).padStart(4, "0")}`,
      })),
      { name: "base", value: base },
    ];
    // Bounded by the test runner's own timeout: the scan must not recheck every offset.
    expect(redactCookieValues("a".repeat(24_000), cookies)).not.toContain("aaaaaaaaaa");
  });
});
