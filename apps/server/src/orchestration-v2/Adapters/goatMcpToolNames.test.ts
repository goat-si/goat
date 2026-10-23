import { describe, expect, it } from "@effect/vitest";

import {
  CLAUDE_MEMORY_WRITE_TOOLS,
  CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS,
  claudeGoatCallTarget,
  claudeGoatMemoryTool,
} from "./goatMcpToolNames.ts";

const GOAT_CALL = "mcp__goat__goat_call";
const preapproved = (toolName: string, toolInput: unknown) =>
  CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS.includes(claudeGoatCallTarget(toolName, toolInput));

describe("Claude approval of GOAT tools in a read-only sandbox", () => {
  it("lets a read-only thread search GOAT without asking", () => {
    expect(preapproved("mcp__goat__goat_describe", { query: "thread" })).toBe(true);
  });

  it("judges goat_call by the tool its path names, by any of that tool's names (#967)", () => {
    for (const path of ["thread.list", "goat_thread_list", "goat_project_read"])
      expect(preapproved(GOAT_CALL, { path, args: {} }), path).toBe(true);
    for (const path of ["thread.send", "task.create", "goat_project_delete"])
      expect(preapproved(GOAT_CALL, { path, args: {} }), path).toBe(false);
    // goat_call is never preapproved as itself, so an unknown or recursive path asks.
    for (const input of [{ path: "thread.teleport" }, { path: "goat_call" }, {}, null])
      expect(preapproved(GOAT_CALL, input), JSON.stringify(input)).toBe(false);
  });

  it("holds goat_call to a memory tool to that tool's memory grant", () => {
    const target = claudeGoatCallTarget(GOAT_CALL, { path: "memory.upsert" });
    const memoryTool = claudeGoatMemoryTool(target);
    expect(memoryTool).toBeDefined();
    expect(CLAUDE_MEMORY_WRITE_TOOLS).toContain(memoryTool);
  });
});
