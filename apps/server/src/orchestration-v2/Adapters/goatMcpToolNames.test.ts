import { describe, expect, it } from "@effect/vitest";

import {
  CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS,
  claudeGoatToolDecision,
} from "./goatMcpToolNames.ts";

const GOAT_CALL = "mcp__goat__goat_call";
const grants = {
  none: { read: false, write: false, source: false },
  read: { read: true, write: false, source: false },
  source: { read: true, write: false, source: true },
  write: { read: true, write: true, source: false },
} as const;

/** The decision for a direct call and for goat_call naming the same tool. */
const decide = (
  tool: string,
  readOnlySandbox: boolean,
  memory: (typeof grants)[keyof typeof grants] | undefined = undefined,
) => {
  const direct = claudeGoatToolDecision({
    toolName: `mcp__goat__${tool}`,
    toolInput: {},
    readOnlySandbox,
    memory,
  });
  const called = claudeGoatToolDecision({
    toolName: GOAT_CALL,
    toolInput: { path: tool, args: {} },
    readOnlySandbox,
    memory,
  });
  return { direct, called };
};

describe("Claude approval of GOAT tools", () => {
  it("lets a read-only thread search GOAT without asking", () => {
    expect(CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS).toContain("mcp__goat__goat_describe");
  });

  it("runs a read through goat_call in a read-only thread without asking, by any of its names (#967)", () => {
    for (const path of ["thread.list", "goat_thread_list", "goat_project_read"])
      expect(
        claudeGoatToolDecision({
          toolName: GOAT_CALL,
          toolInput: { path, args: {} },
          readOnlySandbox: true,
          memory: undefined,
        }),
        path,
      ).toBe("allow");
  });

  it("asks a person before a write through goat_call, as before the same direct write", () => {
    for (const tool of ["goat_thread_send", "goat_task_create", "goat_project_delete"])
      for (const readOnlySandbox of [true, false])
        expect(decide(tool, readOnlySandbox).called, tool).toBe("ask");
  });

  it("asks for a goat_call it cannot resolve to a tool", () => {
    for (const toolInput of [{ path: "thread.teleport" }, { path: "goat_call" }, {}, null])
      expect(
        claudeGoatToolDecision({
          toolName: GOAT_CALL,
          toolInput,
          readOnlySandbox: true,
          memory: grants.write,
        }),
        JSON.stringify(toolInput),
      ).toBe("ask");
  });

  it("holds a memory tool to this credential's grants, directly or through goat_call", () => {
    const cases = [
      ["goat_memory_search", true, grants.none, "deny"],
      ["goat_memory_search", true, grants.read, "allow"],
      ["goat_memory_search", false, grants.read, "ask"],
      ["goat_memory_source_read", true, grants.read, "deny"],
      ["goat_memory_source_read", true, grants.source, "allow"],
      ["goat_memory_upsert", false, grants.read, "deny"],
      ["goat_memory_upsert", true, grants.write, "deny"],
      ["goat_memory_upsert", false, grants.write, "ask"],
    ] as const;
    for (const [tool, readOnlySandbox, memory, expected] of cases) {
      const { direct, called } = decide(tool, readOnlySandbox, memory);
      expect(direct, `${tool} ${readOnlySandbox}`).toBe(expected);
      expect(called, `${tool} ${readOnlySandbox} through goat_call`).toBe(expected);
    }
  });
});
