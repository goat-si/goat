import { assert, describe, it } from "@effect/vitest";

import { loadMcpBridge } from "./mcpBridge.testkit.ts";

describe("Pi tool discovery permissions", () => {
  it("gives long inputs that differ past the shown text different confirmation details", async () => {
    const bridge = await loadMcpBridge({ runtimeMode: "approval-required" });
    const hook = bridge.handlers.get("tool_call") as unknown as (
      event: { toolName: string; input: unknown },
      ctx: { ui: { confirm: (title: string, detail: string) => Promise<boolean> } },
    ) => Promise<{ block: true; reason: string } | undefined>;
    const details: string[] = [];
    const ctx = {
      ui: {
        confirm: async (_title: string, detail: string) => {
          details.push(detail);
          return true;
        },
      },
    };
    const filler = "a".repeat(4_100);
    await hook({ toolName: "bash", input: { command: filler + "\necho one" } }, ctx);
    await hook({ toolName: "bash", input: { command: filler + "\necho two" } }, ctx);
    await hook({ toolName: "bash", input: { command: "ls" } }, ctx);
    const [first, second, short] = details;
    assert.equal(first!.slice(0, 4_000), second!.slice(0, 4_000));
    assert.notEqual(first, second);
    assert.match(first!, /\n\.\.\. \d+ more characters not shown \(sha256 [0-9a-f]{64}\)$/);
    assert.equal(short, JSON.stringify({ command: "ls" }, null, 2));
  });
});
