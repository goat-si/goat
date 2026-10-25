import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

describe("recurrence gate", () => {
  it.each([
    "apps/server/src/provider/CodexProvider.ts",
    "README.md",
    "packages/shared/src/usageLimits.ts",
    "AGENTS.md",
    "apps/server/src/cloud/bootService.ts",
  ])("flags new product copy even in retained upstream paths: %s", (path) => {
    for (const text of ["T3 Code is ready", "Open T3 Code settings"]) {
      expect(findResidue(path, text, KEEP_RULES)).toHaveLength(1);
    }
  });

  it("flags new pairing copy outside the exact retained upstream contexts", () => {
    expect(
      findResidue("apps/web/src/pairing.ts", "Pair with any T3 Code server", KEEP_RULES),
    ).toHaveLength(1);
  });

  it.each([
    ["packages/client-runtime/src/connection/diagnosis.ts", "T3 Code on ${host} did not answer"],
    ["apps/web/src/components/Hint.tsx", "Run `t3 doctor`"],
    ["apps/web/src/invocation.ts", "Run `t3 doctor`"],
    ["apps/server/src/server.ts", "T3CODE_FOO"],
    ["structure/desktop.md", "T3 Code on ${host} did not answer"],
    ["apps/desktop/src/snapShot/KdeSnapShot.ts", "T3 Code capture failed"],
  ])("rejects new product names in %s", (path, text) => {
    expect(findResidue(path, text, KEEP_RULES)).toHaveLength(1);
    const renamed = applyTextRules(path, text, TEXT_RULES).text;
    expect(findResidue(path, renamed, KEEP_RULES)).toEqual([]);
  });

  it.each([
    ["apps/server/src/provider/CodexProvider.ts", 'const CODEX_CLIENT_NAME = "T3 Code";'],
    ["apps/server/src/provider/CodexChatGptAuth.ts", 'agent_name_hint: "T3 Code"'],
    ["apps/desktop/package.json", '"productName": "T3 Code (Alpha)"'],
    [
      "packages/provider-muse/src/server/sdk.ts",
      'clientInfo: { name: "t3_code", title: "T3 Code", version: "1" }',
    ],
    ["packages/contracts/src/relay.ts", '"T3 Code Relay API"'],
    [
      "README.md",
      "GOAT began as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and keeps its fast, event-sourced core. On top of it, GOAT adds:",
    ],
    ["AGENTS.md", "# T3 Code"],
    ["packages/shared/src/goatHome.ts", "T3 Code may be using `~/.t3` at the same time."],
    [
      "packages/shared/src/usageLimits.ts",
      "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?",
    ],
    [
      "apps/server/src/cloud/bootService.ts",
      '.replace(/^Description=T3 Code server$/m, "Description=GOAT server")',
    ],
  ])("keeps the existing exact upstream phrase in %s", (path, text) => {
    expect(findResidue(path, text, KEEP_RULES)).toEqual([]);
    expect(findResidue(path, `${text}; T3 Code is ready`, KEEP_RULES)).toHaveLength(1);
  });

  it.each([
    "upstream T3 Code",
    "Upstream T3 Code",
    "fork of [T3 Code]",
    "fork of T3 Code",
    "any T3 Code install",
    "original T3 Code artwork",
    "original T3 Code copyright",
  ])("keeps the existing upstream context: %s", (text) => {
    expect(findResidue("docs/internals/overview.md", text, KEEP_RULES)).toEqual([]);
  });

  it.each([
    ["apps/server/src/workspace/atomicWorkspaceWrite.ts", "Copyright (c) 2026 T3 Tools Inc."],
    ["README.md", "https://github.com/pingdotgg/t3code"],
    ["apps/desktop/src/app/DesktopAppIdentity.ts", "t3code.desktop"],
    ["packages/contracts/src/adoptLegacyEnv.ts", "const legacy = legacyT3Names.env.foo;"],
    ["apps/server/src/legacyReader.ts", 'const legacy = "T3CODE_FOO"; // goat-rename: legacy'],
    ["apps/web/src/copy.test.ts", "T3 Code; T3CODE_FOO; Run `t3 doctor`"],
  ])("accepts retained attribution or compatibility input in %s", (path, text) => {
    expect(findResidue(path, text, KEEP_RULES)).toEqual([]);
  });

  it.each([
    "T3 Connect",
    "T3 Account",
    "https://t3.codes",
    "T3ConnectClient",
    "t3-relay",
    "T3ComposerEditor",
  ])("does not let external or native keeps hide %s in unrelated source", (text) => {
    expect(findResidue("apps/server/src/unrelated.ts", text, KEEP_RULES)).toHaveLength(1);
  });

  it("keeps an attributed phrase without masking new product copy on the same line", () => {
    expect(
      findResidue(
        "docs/operations/code-quality.md",
        "upstream T3 Code; T3 Code is ready",
        KEEP_RULES,
      ),
    ).toHaveLength(1);
  });

  it("keeps the HTML bridge's legacy t3/ comments but flags a new t3/ writer there", () => {
    const path = "packages/shared/src/htmlRender.ts";
    for (const line of [
      "// A page writes events in goat/ once its client has sent goat/ shortcuts, and in t3/ to a client",
      " * A page that hears goat/ shortcuts answers in goat/ from then on; t3/ still",
    ]) {
      expect(findResidue(path, line, KEEP_RULES)).toEqual([]);
    }
    expect(findResidue(path, 'const method = "t3/newFeature";', KEEP_RULES)).toHaveLength(1);
  });
});
