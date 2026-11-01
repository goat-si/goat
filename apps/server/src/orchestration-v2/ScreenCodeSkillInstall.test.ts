// @effect-diagnostics nodeBuiltinImport:off -- This test inspects the skill's filesystem artifact.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { screenCodeSkillFiles } from "@goat/provider-core/server/builtinSkills/screenCodeSkillFiles";

import { installScreenCodeSkillAt } from "./ScreenCodeSkillInstall.ts";

it("installs and refreshes the screen guide under host state for an attached turn", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-screen-skill-"));
  try {
    const path = installScreenCodeSkillAt(stateDir);
    expect(path).toBe(NodePath.join(stateDir, "skills", "screen-code", "SKILL.md"));
    expect(NodeFS.readFileSync(path!, "utf8")).toBe(screenCodeSkillFiles()["SKILL.md"]);
    NodeFS.writeFileSync(path!, "stale");
    expect(installScreenCodeSkillAt(stateDir)).toBe(path);
    expect(NodeFS.readFileSync(path!, "utf8")).toBe(screenCodeSkillFiles()["SKILL.md"]);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});
