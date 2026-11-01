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
