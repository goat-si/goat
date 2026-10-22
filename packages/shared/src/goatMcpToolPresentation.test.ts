import { describe, expect, it } from "vite-plus/test";

import {
  GOAT_MCP_TOOL_NAMES,
  resolveGoatMcpToolDefinition,
  resolveGoatMcpToolId,
  resolveGoatMcpToolPresentation,
} from "./goatMcpToolPresentation.ts";

describe("resolveGoatMcpToolPresentation", () => {
  it("presents a task move as continuing work on another machine", () => {
    expect(resolveGoatMcpToolPresentation("mcp__goat__channel_task_move")).toEqual({
      displayName: "Continue a GOAT task on another machine",
      logo: "t3-code",
    });
    expect(resolveGoatMcpToolDefinition("channel_task_move")?.summaryAction).toBe(
      "channel-task-move",
    );
  });

  it.each([
    ["t3_attachment_discard", "goat_attachment_discard"],
    ["t3_attachment_prepare_upload", "goat_attachment_prepare_upload"],
    ["t3_environment_preferences_update", "goat_environment_preferences_update"],
    ["t3_environment_read", "goat_environment_read"],
    ["t3_pending_request_list", "goat_pending_request_list"],
    ["t3_pending_request_read", "goat_pending_request_read"],
    ["t3_pending_request_respond", "goat_pending_request_respond"],
    ["t3_preview_close", "goat_preview_close"],
    ["t3_preview_list", "goat_preview_list"],
    ["t3_project_clone", "goat_project_clone"],
    ["t3_project_create", "goat_project_create"],
    ["t3_project_delete", "goat_project_delete"],
    ["t3_project_list", "goat_project_list"],
    ["t3_project_read", "goat_project_read"],
    ["t3_project_update", "goat_project_update"],
    ["t3_queue_cancel", "goat_queue_cancel"],
    ["t3_queue_edit", "goat_queue_edit"],
    ["t3_queue_list", "goat_queue_list"],
    ["t3_queue_promote_to_steer", "goat_queue_promote_to_steer"],
    ["t3_queue_read", "goat_queue_read"],
    ["t3_queue_reorder", "goat_queue_reorder"],
    ["t3_ssh_browse", "goat_ssh_browse"],
    ["t3_ssh_host_list", "goat_ssh_host_list"],
    ["t3_ssh_thread_launch", "goat_ssh_thread_launch"],
    ["t3_thread_configuration", "goat_thread_configuration"],
    ["t3_thread_configure", "goat_thread_configure"],
    ["t3_thread_fork", "goat_thread_fork"],
    ["t3_thread_interrupt", "goat_thread_interrupt"],
    ["t3_thread_launch", "goat_thread_launch"],
    ["t3_thread_list", "goat_thread_list"],
    ["t3_thread_merge_back", "goat_thread_merge_back"],
    ["t3_thread_organize", "goat_thread_organize"],
    ["t3_thread_read", "goat_thread_read"],
    ["t3_thread_search", "goat_thread_search"],
    ["t3_thread_send", "goat_thread_send"],
    ["t3_thread_send_attachments", "goat_thread_send_attachments"],
    ["t3_thread_transfers", "goat_thread_transfers"],
    ["t3_thread_update", "goat_thread_update"],
    ["t3_thread_wait", "goat_thread_wait"],
    ["t3_worktree_handoff", "goat_worktree_handoff"],
    ["t3_worktree_list", "goat_worktree_list"],
    ["t3_worktree_status", "goat_worktree_status"],
  ] as const)("renders persisted %s with the same semantics as %s", (legacy, current) => {
    expect(resolveGoatMcpToolPresentation(current)).not.toBeNull();
    expect(resolveGoatMcpToolDefinition(legacy)).toEqual(resolveGoatMcpToolDefinition(current));
    expect(resolveGoatMcpToolDefinition(legacy)?.summaryAction).toEqual(
      resolveGoatMcpToolDefinition(current)?.summaryAction,
    );
    for (const prefix of ["", "mcp__t3-code__", "t3_code.", "t3-code-thread_with_ids_"]) {
      expect(resolveGoatMcpToolPresentation(`${prefix}${legacy} completed`)).toEqual(
        resolveGoatMcpToolPresentation(`${prefix}${current} completed`),
      );
      // Identity recovery must retain the provider's original spelling.
      expect(resolveGoatMcpToolId(`${prefix}${legacy}`)).toBe(legacy);
      expect(resolveGoatMcpToolId(`${prefix}${current}`)).toBe(current);
    }
    expect(resolveGoatMcpToolPresentation(`mcp__another-server__${legacy}`)).toBeNull();
    expect(resolveGoatMcpToolPresentation(`mcp__another-server__${current}`)).toBeNull();
  });

  it("does not infer an alias for an unknown prefixed tool", () => {
    for (const name of ["t3_unknown_tool", "goat_unknown_tool", "t3-code.goat_thread_start"]) {
      expect(resolveGoatMcpToolPresentation(name)).toBeNull();
      expect(resolveGoatMcpToolId(name)).toBeNull();
    }
  });

  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of GOAT_MCP_TOOL_NAMES) {
      const presentation = resolveGoatMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__goat__",
        "goat.",
        "goat/",
        "goat:",
        "goat · ",
        "mcp_goat_",
        "goat__",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveGoatMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveGoatMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("renders goat names while leaving unknown and foreign tools generic", () => {
    expect(resolveGoatMcpToolPresentation("goat-thread_child_1_delegate_task")?.displayName).toBe(
      "Delegate a child task",
    );
    expect(resolveGoatMcpToolPresentation("goat-thread_child_1_not_a_tool")).toBeNull();
    expect(resolveGoatMcpToolPresentation("mcp__weather__delegate_task")).toBeNull();
    expect(resolveGoatMcpToolPresentation("mcp__goat__not_a_tool")).toBeNull();
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveGoatMcpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveGoatMcpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

it("keeps answer lifecycle labels and permits resolved question reads", () => {
  for (const tool of ["goat_pending_request_respond", "t3_pending_request_respond"]) {
    expect(resolveGoatMcpToolDefinition(tool)?.labels).toEqual([
      "Answer",
      "Answering",
      "Answered",
      "pending questions",
    ]);
    expect(resolveGoatMcpToolDefinition(tool)?.summaryAction).toBe("question-respond");
  }
  expect(resolveGoatMcpToolDefinition("goat_pending_request_read")?.labels).toEqual([
    "Read",
    "Reading",
    "Read",
    "questions",
  ]);
});

it.each(["goat_review_findings_record", "goat_review_findings_export", "channel_task_export"])(
  "presents %s through direct and provider-qualified names",
  (tool) => {
    for (const name of [tool, `mcp__t3-code__${tool}`, `T3-code.${tool}`]) {
      expect(resolveGoatMcpToolDefinition(name)?.labels).toHaveLength(4);
      expect(resolveGoatMcpToolPresentation(name)?.logo).toBe("t3-code");
      expect(resolveGoatMcpToolDefinition(name)?.summaryAction).toBeDefined();
    }
  },
);
