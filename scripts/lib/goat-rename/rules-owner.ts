import type { KeepRule, TextRule } from "./engine.ts";

/**
 * GOAT, not T3 Tools, owns its package metadata, security reporting and contribution guide. Upstream's
 * spellings of those lines rename to GOAT's here, so a chase that takes upstream's side of a conflict
 * and reruns `--apply` still lands on GOAT's values. Decision: devlog/_chase/_fin/10/10.015_t3_chase_owner_and_security.md.
 */
const at =
  (path: string) =>
  (candidate: string): boolean =>
    candidate === path;

const rule = (id: string, path: string, find: RegExp, replace: string): TextRule => ({
  id: `owner:${id}`,
  category: "owner",
  find,
  replace,
  scope: at(path),
});

const GOAT_PACKAGE_OWNER = "GOAT <jun@lidgeai.com>";
const GOAT_ADVISORY_FORM = "https://github.com/goat-si/goat/security/advisories/new";

export const OWNER_TEXT_RULES: readonly TextRule[] = [
  rule(
    "linux-maintainer",
    "scripts/build-desktop-artifact.ts",
    /(?<=maintainer: ")T3 Tools <hello@t3\.codes>(?=")/g,
    GOAT_PACKAGE_OWNER,
  ),
  rule(
    "package-author",
    "scripts/build-desktop-artifact.ts",
    /(?<=author: ")T3 Tools(?=")/g,
    GOAT_PACKAGE_OWNER,
  ),
  // Upstream's SECURITY.md sends reports to upstream's mailbox and policy page; GOAT takes them through
  // GitHub private vulnerability reporting and offers no safe harbor terms.
  rule(
    "security-owner",
    ".github/SECURITY.md",
    /affecting T3 Code or T3 Tools-operated infrastructure to$/g,
    "affecting GOAT through",
  ),
  rule(
    "security-mailbox-link",
    ".github/SECURITY.md",
    /\[security@ping\.gg\]\(mailto:security@ping\.gg\)/g,
    `[GitHub private vulnerability reporting](${GOAT_ADVISORY_FORM})`,
  ),
  rule("security-mailbox", ".github/SECURITY.md", /security@ping\.gg/g, GOAT_ADVISORY_FORM),
  rule(
    "security-policy-page",
    ".github/SECURITY.md",
    /https:\/\/t3\.codes\/security-policy/g,
    "https://github.com/goat-si/goat/security/policy",
  ),
  rule(
    "security-safe-harbor",
    ".github/SECURITY.md",
    /^and safe harbor terms for good-faith research\.$/g,
    "and what to expect.",
  ),
  rule(
    "contributing-model-policy",
    "CONTRIBUTING.md",
    /(?<=requests a PR be filed on )T3 Code(?=,)/g,
    "GOAT",
  ),
];

export const OWNER_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "owner:contributing-fork-attribution",
    pattern: /fork of \[T3 Code\]/g,
    scope: at("CONTRIBUTING.md"),
    reason: "The contribution guide credits the upstream project it started from (10.015).",
  },
];
