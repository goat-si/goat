// @effect-diagnostics nodeBuiltinImport:off -- Exercise the extension gate boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

it("delivers the per-turn screen guide and removes it when disabled", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-screen-"));
  try {
    const gate = NodePath.join(dir, "gate");
    const bridge = await loadMcpBridge({ screenSkillGate: gate });
    const hook = bridge.handlers.get("before_agent_start")!;
    const sections: Record<string, string> = {};
    for (const enabled of [true, false]) {
      await NodeFSP.writeFile(
        gate,
        JSON.stringify({
          screenCode: enabled,
          screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
        }),
      );
      await hook(
        { systemPrompt: "base", systemPromptOptions: { sections } },
        { ui: { notify: assert.fail } },
      );
      const text = sections.goat_screen_code ?? "";
      assert.equal(
        text.includes("Read the screen-code skill at /state/skills/screen-code/SKILL.md"),
        enabled,
      );
      assert.equal(text.includes("goat_screen_run"), enabled);
      for (const term of [
        "list_windows",
        "get_window_state",
        "get_accessibility_tree",
        "element_token",
        "verify_state",
        "run_steps",
        'since:"latest"',
      ])
        assert.notInclude(text, term);
    }
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
