import { describe, expect, it } from "vite-plus/test";

import { applyPathRules, applyTextRules, findResidue, type TextRule } from "./engine.ts";

const rules: readonly TextRule[] = [
  { id: "scope", category: "packages", find: /@t3tools\//g, replace: "@goat/" },
  { id: "env", category: "env", find: /\bT3CODE_([A-Z_]+)\b/g, replace: "GOAT_$1" },
];

describe("applyTextRules", () => {
  it("is a no-op on its own output", () => {
    const source = 'import { x } from "@t3tools/contracts";\nconst home = env.T3CODE_HOME;\n';
    const once = applyTextRules("a.ts", source, rules);
    expect(once.text).toBe('import { x } from "@goat/contracts";\nconst home = env.GOAT_HOME;\n');
    expect(once.hits.get("scope")).toBe(1);
    expect(applyTextRules("a.ts", once.text, rules).text).toBe(once.text);
  });

  it("keeps marked lines and regions", () => {
    const source = [
      "const a = env.T3CODE_HOME; // goat-rename: legacy",
      "# goat-rename: legacy-begin",
      'T3CODE_HOME="${T3CODE_HOME:-}"',
      "# goat-rename: legacy-end",
      "const b = env.T3CODE_PORT;",
    ].join("\n");
    const lines = applyTextRules("install.sh", source, rules).text.split("\n");
    expect(lines[0]).toContain("T3CODE_HOME");
    expect(lines[2]).toContain("T3CODE_HOME");
    expect(lines[4]).toBe("const b = env.GOAT_PORT;");
  });

  it("respects rule scope", () => {
    const scoped: TextRule = { ...rules[1]!, scope: (path) => path.startsWith("apps/") };
    expect(applyTextRules("infra/x.ts", "T3CODE_HOME", [scoped]).text).toBe("T3CODE_HOME");
  });

  it("holds an exact keep through apply while the rest of the line still renames", () => {
    const keeps = [
      {
        id: "alias",
        pattern: /(?<=set\.)T3CODE_HOME\b/g,
        reason: "legacy alias",
        holdsOnApply: true,
      },
      { id: "scan-only", pattern: /T3CODE_PORT/g, reason: "scan mask" },
    ] as const;
    const source = "set.T3CODE_HOME T3CODE_HOME T3CODE_PORT";
    const result = applyTextRules("a.ts", source, rules, keeps);
    expect(result.text).toBe("set.T3CODE_HOME GOAT_HOME GOAT_PORT");
    expect(result.hits.get("env")).toBe(2);
  });
});

describe("applyPathRules", () => {
  it("moves matching paths only", () => {
    const rule = {
      id: "lint",
      category: "tooling",
      find: /^oxlint-plugin-t3code\//g,
      replace: "oxlint-plugin-goat/",
    };
    expect(applyPathRules("oxlint-plugin-t3code/index.ts", [rule])).toBe(
      "oxlint-plugin-goat/index.ts",
    );
    expect(applyPathRules("apps/web/index.ts", [rule])).toBe("apps/web/index.ts");
  });
});

describe("findResidue", () => {
  const keeps = [{ id: "relay", pattern: /x-t3-relay-[a-z-]+/g, reason: "upstream relay" }];

  it("reports T3 spellings that no keep rule explains", () => {
    const source =
      'headers["x-t3-relay-delivery-id"];\nconst t3Home = 1;\nconst view = new Uint32Array(); // uint32_t, int32\n';
    expect(findResidue("a.ts", source, keeps).map((item) => item.line)).toEqual([2]);
  });

  it("ignores legacy-marked lines", () => {
    expect(findResidue("a.ts", 'const LEGACY = "t3code"; // goat-rename: legacy', keeps)).toEqual(
      [],
    );
  });
});
