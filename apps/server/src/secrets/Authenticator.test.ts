import { describe, expect, it } from "vitest";

import { generateCode, parseSetupKey } from "./Authenticator.ts";

describe("authenticator setup keys", () => {
  it("accepts base32 and TOTP URIs with parameters", () => {
    expect(parseSetupKey("  jbsw y3dp  ")).toEqual({
      secret: "JBSWY3DP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(
      parseSetupKey("otpauth://totp/example?secret=JBSWY3DP&algorithm=SHA512&digits=8&period=60"),
    ).toEqual({ secret: "JBSWY3DP", algorithm: "SHA512", digits: 8, period: 60 });
  });

  it("rejects invalid base32, HOTP, and invalid URI parameters", () => {
    for (const value of [
      "",
      "ABC1",
      "A",
      "otpauth://hotp/x?secret=JBSWY3DP",
      "otpauth://totp/x?secret=ABC1",
      "otpauth://totp/x?secret=JBSWY3DP&algorithm=MD5",
      "otpauth://totp/x?secret=JBSWY3DP&digits=7",
      "otpauth://totp/x?secret=JBSWY3DP&period=14",
      "otpauth://totp/x?secret=JBSWY3DP&period=121",
      "otpauth://totp/x?secret=JBSWY3DP&secret=JBSWY3DP",
    ]) {
      expect(parseSetupKey(value), value).toBeUndefined();
    }
  });
});

describe("time-based codes", () => {
  it("matches the RFC 6238 Appendix B vectors and a six digit code", () => {
    const vectors = [
      [
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        "SHA1",
        ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"],
      ],
      [
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
        "SHA256",
        ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"],
      ],
      [
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA",
        "SHA512",
        ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"],
      ],
    ] as const;
    const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
    for (const [secret, algorithm, expected] of vectors) {
      for (const [index, seconds] of times.entries()) {
        expect(generateCode({ secret, algorithm, digits: 8, period: 30 }, seconds * 1000)).toBe(
          expected[index],
        );
      }
    }
    expect(
      generateCode({ secret: vectors[0][0], algorithm: "SHA1", digits: 6, period: 30 }, 59000),
    ).toBe("287082");
  });
});
