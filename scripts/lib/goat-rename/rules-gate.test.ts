import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

describe("recurrence gate", () => {
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
    ["apps/server/src/workspace/atomicWorkspaceWrite.ts", "Copyright (c) 2026 T3 Tools Inc."],
    ["README.md", "https://github.com/pingdotgg/t3code"],
    ["apps/desktop/src/app/DesktopAppIdentity.ts", "t3code.desktop"],
    ["packages/contracts/src/adoptLegacyEnv.ts", "const legacy = legacyT3Names.env.foo;"],
    ["apps/server/src/cli/connect.ts", "T3 Connect"],
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
});
