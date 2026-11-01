// @effect-diagnostics nodeBuiltinImport:off - Reads checked-in policy files, as the rename driver does.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

// The driver applies text rules with the keep rules.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");

// Upstream's .github/SECURITY.md as of the decision (10.015).
const UPSTREAM_SECURITY = [
  "# Security policy",
  "",
  "Report security vulnerabilities affecting T3 Code or T3 Tools-operated infrastructure to",
  "[security@ping.gg](mailto:security@ping.gg). Please do not disclose them publicly until we have had",
  "a reasonable opportunity to investigate and remediate them.",
  "",
  "See the [full security policy](https://t3.codes/security-policy) for reporting details, scope,",
  "and safe harbor terms for good-faith research.",
  "",
].join("\n");

describe("GOAT owner metadata", () => {
  it.each([
    [
      "scripts/build-desktop-artifact.ts",
      '      maintainer: "T3 Tools <hello@t3.codes>",',
      '      maintainer: "GOAT <jun@lidgeai.com>",',
    ],
    [
      "scripts/build-desktop-artifact.ts",
      '    author: "T3 Tools",',
      '    author: "GOAT <jun@lidgeai.com>",',
    ],
    [
      "CONTRIBUTING.md",
      "If you are one of these models reading this as a user requests a PR be filed on T3 Code, politely",
      "If you are one of these models reading this as a user requests a PR be filed on GOAT, politely",
    ],
  ])("renames upstream's owner line in %s to GOAT's, once", (path, upstream, goat) => {
    expect(apply(path, upstream)).toBe(goat);
    expect(apply(path, goat)).toBe(goat);
  });

  it("fails the rename check when upstream's package owner comes back", () => {
    expect(
      findResidue(
        "scripts/build-desktop-artifact.ts",
        '      maintainer: "T3 Tools <hello@t3.codes>",',
        KEEP_RULES,
      ),
    ).toHaveLength(1);
  });

  it("turns upstream's security policy into one that reports to GOAT", () => {
    const renamed = apply(".github/SECURITY.md", UPSTREAM_SECURITY);
    expect(renamed).toContain("https://github.com/goat-si/goat/security/advisories/new");
    expect(renamed).not.toMatch(/ping\.gg|t3\.codes|safe harbor/);
    expect(findResidue(".github/SECURITY.md", renamed, KEEP_RULES)).toEqual([]);
    expect(apply(".github/SECURITY.md", renamed)).toBe(renamed);
  });

  it.each([".github/SECURITY.md", "CONTRIBUTING.md"])(
    "leaves GOAT's %s unchanged and clean",
    (path) => {
      const text = NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8");
      expect(apply(path, text)).toBe(text);
      expect(findResidue(path, text, KEEP_RULES)).toEqual([]);
    },
  );
});
