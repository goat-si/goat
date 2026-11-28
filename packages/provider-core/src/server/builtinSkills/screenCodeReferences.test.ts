import { ScreenRunError, SCREEN_TARGET_API } from "@goat/contracts";

import { expect, it } from "vite-plus/test";
import { screenCodeSkillFiles } from "./screenCodeSkillFiles.ts";

it("ships references covering the error schema and only current screen methods", () => {
  const files = screenCodeSkillFiles();
  const errors = files["references/errors.md"] ?? "";
  const workflows = files["references/workflows.md"] ?? "";
  for (const code of ScreenRunError.fields.code.literals)
    expect(errors, code).toContain(`\`${code}\``);
  expect(workflows).not.toBe("");
  for (const match of workflows.matchAll(/\b(?:screen|app|obs)\.([A-Za-z]+)\s*\(/g)) {
    expect(SCREEN_TARGET_API, match[0]).toMatch(new RegExp(`\\b${match[1]}\\s*\\(`));
  }
  for (const term of [
    "list_windows",
    "get_window_state",
    "get_accessibility_tree",
    "element_token",
    "verify_state",
    "run_steps",
    'since:"latest"',
    'since: "latest"',
  ]) {
    expect(errors + workflows).not.toContain(term);
  }
});

it("never promises nothing was sent for codes GOAT also raises after input went out", () => {
  const errors = screenCodeSkillFiles()["references/errors.md"] ?? "";
  // Each of these can follow a dispatched input with effectStarted true (post-input reads, launches, redirects).
  for (const code of [
    "stale_reference",
    "user_interacting",
    "screen_locked",
    "permission_denied",
    "blocked_url",
  ]) {
    const line =
      errors.split("\n").find((each) => each.startsWith("- \u0060" + code + "\u0060")) ?? "";
    expect(line, code).not.toBe("");
    expect(line, code).not.toMatch(/; nothing sent for (the|that) refus/);
  }
});

it("documents browser click refusal details, tab click modifiers, and windowless app behavior accurately", () => {
  const files = screenCodeSkillFiles();
  const errors = files["references/errors.md"] ?? "";
  const guide = files["SKILL.md"] ?? "";
  const unsupportedLine =
    errors.split("\n").find((each) => each.startsWith("- `unsupported`")) ?? "";
  expect(unsupportedLine).toContain("occluded_refused");
  expect(unsupportedLine).toContain("special_element_refused");
  expect(guide).toContain(
    'App and tab clicks accept `{modifiers: ["cmd", "shift", "alt", "ctrl"]}`',
  );
  expect(guide).not.toContain("tabs refuse modifiers");
  expect(guide).toContain("a running app with no window fails with `target_missing`");
  expect(guide).not.toContain("launches a closed or windowless app");
});
