import { describe, expect, it } from "vite-plus/test";
import { applyTextRules } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

// The driver applies text rules with the keep rules.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

describe("sample names", () => {
  it("renames maintainer samples in tests", () => {
    expect(
      apply(
        "packages/ssh/src/tunnel.fixture.ts",
        'username: "julius", path: "/Users/julius/x", label: "Julius iPhone", repo: "juliusmarminge/goat"',
      ),
    ).toBe(
      'username: "alex", path: "/Users/alex/x", label: "Alex iPhone", repo: "alexmorgan/goat"',
    );
    expect(apply("a/b.test.ts", '{ login: "t3dotgg", name: "theo" }, "C:\\\\Users\\\\Theo"')).toBe(
      '{ login: "riven-example", name: "sam" }, "C:\\\\Users\\\\Sam"',
    );
  });

  it("leaves other words and non-test paths alone", () => {
    const text = "THEORY theory Pantheon Juliusz";
    expect(apply("a/b.test.ts", text)).toBe(text);
    expect(apply("docs/user/guide.md", "ask julius or theo")).toBe("ask julius or theo");
  });

  it("uses a neutral branch prefix in the settings example", () => {
    expect(
      apply(
        "apps/web/src/components/settings/BranchNamingSettings.tsx",
        '"Use julius/ followed by the issue ID and a short description."',
      ),
    ).toBe('"Use feature/ followed by the issue ID and a short description."');
  });
});
