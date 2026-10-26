// @effect-diagnostics nodeBuiltinImport:off - Reads repository test files to check the title table; a maintenance-script test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { TEST_TITLES } from "./rules-meta.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;
const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");

describe("GOAT meta", () => {
  it("turns upstream's dev container into GOAT's and keeps the existing workspace home", () => {
    const path = ".devcontainer/devcontainer.json";
    const upstream = [
      "// Dev container for T3 Code. Mirrors CI (ubuntu-24.04, Node 26, Rust stable)",
      '  "name": "T3 Code",',
      "    // Keep all runtime state inside the (gitignored) workspace .t3, matching",
      "    // the worktree default. An explicit --home-dir still wins.",
      '    "T3CODE_HOME": "${containerWorkspaceFolder}/.t3"',
      '    "source=t3code-pnpm-store,target=/home/vscode/.cache/pnpm,type=volume",',
      '      "label": "t3 server",',
    ].join("\n");
    const renamed = apply(path, upstream);
    expect(renamed).toBe(
      [
        "// Dev container for GOAT. Mirrors CI (ubuntu-24.04, Node 26, Rust stable)",
        '  "name": "GOAT",',
        "    // Keep all runtime state inside the (gitignored) workspace .t3, which holds",
        "    // an existing container's state. An explicit --home-dir still wins.",
        '    "GOAT_HOME": "${containerWorkspaceFolder}/.t3"',
        '    "source=goat-pnpm-store,target=/home/vscode/.cache/pnpm,type=volume",',
        '      "label": "GOAT server",',
      ].join("\n"),
    );
    expect(apply(path, renamed)).toBe(renamed);
    expect(findResidue(path, renamed, KEEP_RULES)).toEqual([]);
    expect(apply(".devcontainer/on-create.sh", "T3 Code devcontainer")).toBe("GOAT devcontainer");
    expect(apply(".devcontainer/on-create.sh", "optional: enable T3 Connect cloud features")).toBe(
      "optional: upstream Connect identifiers (unused by GOAT)",
    );
  });

  it("points issue forms and contribution links at GOAT", () => {
    expect(
      apply(".github/ISSUE_TEMPLATE/via-triage.yml", "Filed with `npx t3 triage` via t3 triage"),
    ).toBe("Filed with `goat triage` via goat triage");
    const ideas = "https://github.com/pingdotgg/t3code/discussions/categories/ideas";
    const goatIdeas = "https://github.com/goat-si/goat/discussions/categories/ideas";
    expect(apply(".github/ISSUE_TEMPLATE/config.yml", `    url: ${ideas}`)).toBe(
      `    url: ${goatIdeas}`,
    );
    expect(apply("CONTRIBUTING.md", `[Ideas discussions](${ideas}).`)).toBe(
      `[Ideas discussions](${goatIdeas}).`,
    );
    expect(
      apply("CONTRIBUTING.md", "https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md"),
    ).toBe("https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md");
  });

  it("documents the .goat default and the legacy .t3 fallback in one pass over upstream's guide", () => {
    const path = "docs/operations/observability.md";
    const upstream = [
      "`<home>/userdata/logs/server.trace.ndjson` (so `~/.t3/userdata/...` by default, or",
      "Only an implicit dev run outside a linked worktree uses the shared dev directory:",
      'TRACE_FILE="$HOME/.t3/dev/logs/server.trace.ndjson"',
    ].join("\n");
    const renamed = apply(path, upstream);
    expect(renamed).toBe(
      [
        "`<home>/userdata/logs/server.trace.ndjson` (so `~/.goat/userdata/...` by default, `~/.t3/userdata/...` while only that legacy home holds state, or",
        "Only an implicit dev run outside a linked worktree uses the shared dev directory (`~/.t3/dev` while only that one exists):",
        'STATE_HOME="$HOME/.goat"; [ -d "$STATE_HOME/dev" ] || [ ! -d "$HOME/.t3"/dev ] || STATE_HOME="$HOME/.t3"; TRACE_FILE="$STATE_HOME/dev/logs/server.trace.ndjson"',
      ].join("\n"),
    );
    expect(apply(path, renamed)).toBe(renamed);
  });

  it("says in .env.example that upstream values enable nothing in GOAT", () => {
    const upstream = [
      "# Optional: T3 Connect source builds",
      "# `cp .env.example .env` enables T3 Connect against the production deployment.",
      "# These are the same public identifiers baked into official release builds, not",
      "# secrets. Remove or comment them out to build with cloud features disabled.",
    ].join("\n");
    const renamed = apply(".env.example", upstream);
    expect(renamed).toBe(
      [
        "# Optional: GOAT Connect source builds",
        "# GOAT Connect is off in every build, so copying this file to .env enables nothing yet.",
        "# These public identifiers are not secrets. They remain for upstream compatibility;",
        "# GOAT does not use them to enable cloud features.",
      ].join("\n"),
    );
    expect(apply(".env.example", renamed)).toBe(renamed);
    expect(findResidue(".env.example", renamed, KEEP_RULES)).toEqual([]);
  });
});

describe("test titles", () => {
  it.each(TEST_TITLES)("renames the title in %s", (path, from, to) => {
    expect(apply(path, `it("${from}", () => {`)).toBe(`it("${to}", () => {`);
    expect(apply(path, `it("${to}", () => {`)).toBe(`it("${to}", () => {`);
    const source = NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8");
    expect(source.split(to).length - 1).toBe(1);
    expect(source.includes(from)).toBe(false);
  });
});
