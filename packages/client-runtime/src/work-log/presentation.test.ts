import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  formatCommandActionsLabel,
  resolveWorkEntryToolPresentation,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  toolGroupAction,
  summarizeToolGroup,
  toolGroupSummaryKind,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    exitCode: 0,
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(workEntryIndicatesToolSuccess(entry)).toBe(!failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.goat_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
    expect(workEntryIndicatesToolSuccess(childFailure)).toBe(true);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("commands that only inspect files", () => {
  const entry = (
    id: string,
    input: string,
    commandActions: Extract<
      OrchestrationV2TurnItem,
      { type: "command_execution" }
    >["commandActions"],
  ): WorkLogPresentationEntry => ({
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Ran command",
    tone: "tool",
    command: input,
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    structuredPayload: commandItem({ input, ...(commandActions ? { commandActions } : {}) }),
  });

  it("takes the row kind from the command's actions and keeps real commands as commands", () => {
    expect(toolGroupAction(entry("r", "cat a.ts", [{ type: "read", path: "a.ts" }]))).toBe("read");
    expect(toolGroupAction(entry("l", "ls src", [{ type: "list", path: "src" }]))).toBe("list");
    expect(toolGroupAction(entry("s", "rg foo", [{ type: "search", query: "foo" }]))).toBe(
      "code-search",
    );
    expect(
      toolGroupAction(
        entry("m", "rg foo && cat a.ts", [
          { type: "search", query: "foo" },
          { type: "read", path: "a.ts" },
        ]),
      ),
    ).toBe("code-search");
    expect(toolGroupAction(entry("c", "vp test run", []))).toBe("command");
    expect(toolGroupAction(entry("u", "vp test run", undefined))).toBe("command");
  });

  it("labels each kind with its file or query", () => {
    expect(formatCommandActionsLabel([{ type: "read", path: "src/a.ts" }])).toBe("Read src/a.ts");
    expect(
      formatCommandActionsLabel([
        { type: "read", path: "a.ts" },
        { type: "read", path: "b.ts" },
      ]),
    ).toBe("Read a.ts +1 more");
    expect(formatCommandActionsLabel([{ type: "list", path: "apps/web" }])).toBe("Listed apps/web");
    expect(formatCommandActionsLabel([{ type: "list", path: "." }])).toBe("Listed files");
    expect(
      formatCommandActionsLabel([{ type: "list", path: "provider" }], {
        formatPath: (path) => `repo/${path}`,
      }),
    ).toBe("Listed provider");
    expect(
      formatCommandActionsLabel([{ type: "search", query: "useEffect", path: "apps/web/src" }]),
    ).toBe("Searched useEffect in src");
    expect(
      formatCommandActionsLabel(
        [
          { type: "search", query: "foo", path: "src" },
          { type: "read", path: "/repo/src/a.ts" },
        ],
        { active: true, formatPath: (path) => path.replace("/repo/", "") },
      ),
    ).toBe("Searching foo in src, reading src/a.ts");
  });

  it("summarizes reads by distinct file and merges exploration kinds", () => {
    const reads = [
      entry("r1", "cat a.ts", [{ type: "read", path: "a.ts" }]),
      entry("r2", "sed -n 1,40p a.ts", [{ type: "read", path: "a.ts" }]),
      entry("r3", "cat b.ts c.ts", [
        { type: "read", path: "b.ts" },
        { type: "read", path: "c.ts" },
      ]),
    ];
    expect(summarizeToolGroup(reads).summary).toBe("Read 3 files");
    expect(toolGroupSummaryKind(reads)).toBe("read");
    expect(
      summarizeToolGroup([
        ...reads,
        entry("l1", "ls", [{ type: "list" }]),
        entry("s1", "rg foo", [{ type: "search", query: "foo" }]),
        entry("c1", "vp test run", []),
      ]).summary,
    ).toBe("Explored 3 files, 1 search, 1 list and ran 1 command");
    expect(
      toolGroupSummaryKind([...reads, entry("s2", "rg foo", [{ type: "search", query: "foo" }])]),
    ).toBe("code-search");
  });

  it("counts each kind a mixed command ran without counting the command twice", () => {
    const listAndRead = entry("m1", "ls src && cat a.ts", [
      { type: "list", path: "src" },
      { type: "read", path: "a.ts" },
    ]);
    expect(summarizeToolGroup([listAndRead]).summary).toBe("Explored 1 file, 1 list");
    expect(
      summarizeToolGroup([
        listAndRead,
        entry("s1", "rg foo src && rg bar src", [
          { type: "search", query: "foo", path: "src" },
          { type: "search", query: "bar", path: "src" },
        ]),
        entry("c1", "vp test run", []),
        entry("c2", "git status", []),
        {
          id: "w1",
          createdAt: "2026-01-01T00:00:00.000Z",
          label: "Search",
          tone: "tool",
          itemType: "web_search",
        },
      ]).summary,
    ).toBe("Explored 1 file, 2 searches, 1 list, ran 2 commands, and performed 1 other action");
  });
});
