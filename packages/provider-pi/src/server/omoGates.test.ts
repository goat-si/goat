// @effect-diagnostics nodeBuiltinImport:off -- Tests the extension filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

it.each(["full-access", "approval-required"])(
  "blocks OmO native spawn and desktop tools in %s",
  async (runtimeMode) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-omo-gates-"));
    try {
      const gate = NodePath.join(directory, "subagents");
      await NodeFSP.writeFile(gate, "off");
      const bridge = await loadMcpBridge({
        modern: true,
        runtimeMode,
        profile: "omo",
        subagentGate: gate,
      });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { ui: { confirm: () => Promise<boolean> } },
      ) => Promise<{ block: true } | undefined>;
      const ctx = { ui: { confirm: async () => true } };
      for (const toolName of [
        "subagent",
        "task",
        "team_create",
        "workpool",
        "workflow",
        "computer",
        "computer_actions",
      ]) {
        assert.equal((await hook({ toolName, input: {} }, ctx))?.block, true, toolName);
      }
      await NodeFSP.writeFile(gate, "on");
      assert.isUndefined(await hook({ toolName: "task", input: {} }, ctx));
      assert.equal((await hook({ toolName: "computer", input: {} }, ctx))?.block, true);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
