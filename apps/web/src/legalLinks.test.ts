import { describe, expect, it } from "@effect/vitest";

import { PRIVACY_POLICY_URL } from "./legalLinks";

describe("legal links", () => {
  it("never name the source repository, which release bundles may not ship (D-10)", () => {
    expect(PRIVACY_POLICY_URL).not.toMatch(
      /(?:github\.com[/:]|repos\/)goat-si\/goat(?!(?:-releases|_))/i,
    );
    expect(PRIVACY_POLICY_URL).toBe("https://goat-si.github.io/goat/privacy-policy/#usage-data");
  });
});
