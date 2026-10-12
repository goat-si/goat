import { describe, expect, it } from "vite-plus/test";

import { applyTextRules } from "./engine.ts";
import { TEXT_RULES } from "./rules.ts";

const server = (source: string) => applyTextRules("apps/server/src/x.ts", source, TEXT_RULES).text;

describe("server service keys", () => {
  it("renames Effect keys", () => {
    expect(server('>()("t3/serverActivation") {}')).toBe('>()("goat/serverActivation") {}');
    expect(server('  "t3/orchestration-v2/EventStore/EventStoreV2",')).toBe(
      '  "goat/orchestration-v2/EventStore/EventStoreV2",',
    );
    expect(server('Context.Reference("t3/keybindings")')).toBe(
      'Context.Reference("goat/keybindings")',
    );
  });

  it("keeps branch names", () => {
    for (const branch of ["t3/abcd1234", "t3/renamed", "t3/feature-x", "t3/ssh/12345678"]) {
      expect(server(`launchFrom("${branch}")`)).toBe(`launchFrom("${branch}")`);
    }
  });
});

describe("package scope", () => {
  it("renames the scope in imports and escaped regular expressions", () => {
    const source = 'import "@t3tools/shared/path";\nconst pkg = /node_modules\\/@t3tools\\//;';
    expect(applyTextRules("scripts/x.ts", source, TEXT_RULES).text).toBe(
      'import "@goat/shared/path";\nconst pkg = /node_modules\\/@goat\\//;',
    );
  });
});

describe("env names", () => {
  const rename = (source: string) =>
    applyTextRules("apps/server/src/x.ts", source, TEXT_RULES).text;

  it("maps every legacy prefix to GOAT_", () => {
    expect(rename("env.T3CODE_HOME, env.T3_MCP_URL, env.T3_CODE_MCP_AUTHORIZATION")).toBe(
      "env.GOAT_HOME, env.GOAT_MCP_URL, env.GOAT_MCP_AUTHORIZATION",
    );
    expect(rename(String.raw`"VITE_T3CODE_WEB_SOURCEMAP", "\nT3CODE_PORT=1"`)).toBe(
      String.raw`"VITE_GOAT_WEB_SOURCEMAP", "\nGOAT_PORT=1"`,
    );
  });

  it("keeps relay keys, runner shell names and unrelated words", () => {
    const kept =
      "T3CODE_RELAY_URL VITE_T3CODE_RELAY_URL T3CODE_CLERK_PUBLISHABLE_KEY T3_ARCHIVE_VERSION T3_LOCK uint32_t";
    expect(rename(kept)).toBe(kept);
  });

  it("leaves the SSH runner untouched", () => {
    expect(applyTextRules("packages/ssh/src/tunnel.ts", "T3CODE_NO_BROWSER", TEXT_RULES).text).toBe(
      "T3CODE_NO_BROWSER",
    );
  });
});

describe("fixtures", () => {
  const rename = (source: string) => applyTextRules("apps/x.test.ts", source, TEXT_RULES).text;

  it("renames disposable temp prefixes and generated prompt ids only", () => {
    expect(rename('makeTempDirectoryScoped({ prefix: "t3code-git-manager-" })')).toBe(
      'makeTempDirectoryScoped({ prefix: "goat-git-manager-" })',
    );
    expect(rename('mkdtempSync(join(tmpdir(), "t3-launcher-"))')).toBe(
      'mkdtempSync(join(tmpdir(), "goat-launcher-"))',
    );
    expect(rename('"t3-xai-prompt-1"')).toBe('"goat-xai-prompt-1"');
    const kept = 'const link = "t3-thread://v1/x"; registerServer("t3-code");';
    expect(rename(kept)).toBe(kept);
  });
});

describe("later env and storage rules", () => {
  it("renames env wildcards and web storage keys only", () => {
    const web = (source: string) => applyTextRules("apps/web/src/x.ts", source, TEXT_RULES).text;
    expect(web("set the T3CODE_BITBUCKET_* variables")).toBe("set the GOAT_BITBUCKET_* variables");
    expect(web('const KEY = "t3code:prompt-link-opener";')).toBe(
      'const KEY = "goat:prompt-link-opener";',
    );
    const kept = 'const origin = "t3code://app";';
    expect(web(kept)).toBe(kept);
    const mobile = '"t3code:",';
    expect(applyTextRules("apps/mobile/src/pairing.ts", mobile, TEXT_RULES).text).toBe(mobile);
  });
});

describe("client dotted ids", () => {
  it("renames dotted ids but not the t3.json source label", () => {
    const web = (source: string) => applyTextRules("apps/web/src/x.ts", source, TEXT_RULES).text;
    expect(web('const KEY = "t3.backgroundActivity.clientId";')).toBe(
      'const KEY = "goat.backgroundActivity.clientId";',
    );
    expect(web('source === "t3.json"')).toBe('source === "t3.json"');
    const kept = 'fixture("t3.chat"); key("t3.pullRequests.preferences");';
    expect(web(kept)).toBe(kept);
  });
});
