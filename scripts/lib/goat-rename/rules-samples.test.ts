import { describe, expect, it } from "vite-plus/test";
import { applyTextRules } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

// The driver applies text rules with the keep rules.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

describe("sample names", () => {
  it("renames multiline GitHub identities without changing nested GitLab fixtures (#1923)", () => {
    const path = "packages/client-runtime/src/changeRequestLinks.test.ts";
    const source = [
      'canonicalKey: "github.com/pingdotgg/t3code",',
      'owner: "pingdotgg",',
      'name: "t3code",',
    ].join("\n");
    const renamed = [
      'canonicalKey: "github.com/goat-si/goat",',
      'owner: "goat-si",',
      'name: "goat",',
    ].join("\n");
    expect(apply(path, source)).toBe(renamed);
    expect(apply(path, renamed)).toBe(renamed);
    const nested = 'owner: "t3tools",\nname: "t3code",';
    expect(apply(path, nested)).toBe(nested);
    const unrelated = 'owner: "pingdotgg",\nname: "t3code",';
    expect(apply("a/b.test.ts", unrelated)).toBe(unrelated);
  });

  it("keeps fork head names aligned with their renamed expectations (#1923)", () => {
    const path = "packages/source-control-github/src/server/gitHubPullRequests.test.ts";
    const source = [
      'headRepository: { id: "R_1", name: "t3code" },',
      'headRepositoryOwner: { login: "binbandit" },',
      'headRepositoryNameWithOwner: "binbandit/t3code",',
    ].join("\n");
    const renamed = [
      'headRepository: { id: "R_1", name: "goat" },',
      'headRepositoryOwner: { login: "binbandit" },',
      'headRepositoryNameWithOwner: "binbandit/goat",',
    ].join("\n");
    expect(apply(path, source)).toBe(renamed);
    expect(apply(path, renamed)).toBe(renamed);
    const unrelated = 'headRepository: { id: "R_1", name: "t3code" },';
    expect(apply("a/b.test.ts", unrelated)).toBe(unrelated);
    expect(apply(path, 'headRepository: { name: "t3code-fork" },')).toBe(
      'headRepository: { name: "t3code-fork" },',
    );
  });

  it("keeps palette reference queries aligned with renamed repository fixtures", () => {
    const source = '"pingdotgg/t3code#22889" "t3code#22889" "t3code#2288"';
    expect(apply("packages/shared/src/paletteSearch.test.ts", source)).toBe(
      '"goat-si/goat#22889" "goat#22889" "goat#2288"',
    );
    expect(apply("src/legacy.ts", '"t3code#22889"')).toBe('"t3code#22889"');
  });

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

  it("points upstream sample repositories in tests at GOAT", () => {
    expect(
      apply(
        "a/b.test.ts",
        '{ owner: "pingdotgg", name: "t3code" } pingdotgg/t3code PingDotGG/T3Code',
      ),
    ).toBe('{ owner: "goat-si", name: "goat" } goat-si/goat Goat-SI/Goat');
    expect(
      apply(
        "a/b.test.ts",
        "t3tools/t3code T3Tools/t3code T3Tools/T3Code com.t3tools.T3Code.desktop",
      ),
    ).toBe("sample-tools/goat Sample-Tools/goat Sample-Tools/Goat com.t3tools.T3Code.desktop");
    expect(apply("a/b.test.ts", "/work/t3code /work/t3code-2 /work/t3code-fork")).toBe(
      "/work/sample-repo /work/sample-repo-2 /work/t3code-fork",
    );
    // Upstream is the subject of these tests, and replay transcripts record the real checkout.
    for (const path of ["apps/server/src/cli/triagePrompt.test.ts", "src/x.ts"]) {
      expect(apply(path, "pingdotgg/t3code")).toBe("pingdotgg/t3code");
    }
    expect(apply("a/b.test.ts", "/home/replay-user/t3code C:/Users/mike/t3code")).toBe(
      "/home/replay-user/t3code C:/Users/mike/t3code",
    );
  });
});
