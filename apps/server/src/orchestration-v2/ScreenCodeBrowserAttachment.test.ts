// @effect-diagnostics nodeBuiltinImport:off -- The installed guide is a filesystem artifact.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveBuiltInSkills } from "@goat/provider-core/server/builtinSkills/registry";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

import { installScreenCodeSkillAt } from "./ScreenCodeSkillInstall.ts";

it("gives a browser-only turn its installed screen-code path and keeps guidance if writing fails", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-browser-guide-"));
  try {
    const active = resolveBuiltInSkills({ attached: ["browser"] }).active;
    expect(active).toEqual(["screen-code"]);
    const path = installScreenCodeSkillAt(stateDir);
    expect(path).toBe(NodePath.join(stateDir, "skills", "screen-code", "SKILL.md"));
    expect(NodeFS.existsSync(path!)).toBe(true);
    expect(
      buildRuntimeInstructions({
        harness: "Cursor",
        screenCode: active.includes("screen-code"),
        screenCodeSkillPath: path,
        screenCodeCompact: true,
      }),
    ).toContain(path);

    const blocked = NodePath.join(stateDir, "blocked");
    NodeFS.writeFileSync(blocked, "file, not directory");
    expect(installScreenCodeSkillAt(blocked)).toBeUndefined();
    expect(
      buildRuntimeInstructions({ harness: "ACP", screenCode: true, screenCodeCompact: true }),
    ).toContain("<screen_code>");
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});
