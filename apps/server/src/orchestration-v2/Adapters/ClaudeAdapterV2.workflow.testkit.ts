import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export const WORKFLOW_TASK_ID = "task-workflow-run";
export const WORKFLOW_TOOL_USE_ID = "toolu-workflow-run";

/** Claude Agent SDK frames for a background workflow run on one native session. */
export function claudeWorkflowFrames(
  sessionId: string,
  claudeSdkFrame: (frame: unknown) => SDKMessage,
) {
  const workflowToolUse = claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: WORKFLOW_TOOL_USE_ID,
          name: "Workflow",
          input: { script: "alpha.js" },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000001001",
    session_id: sessionId,
  });
  const workflowTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    description: "Run the alpha workflow",
    task_type: "local_workflow",
    workflow_name: "probe-wf",
    uuid: "00000000-0000-4000-8000-000000001002",
    session_id: sessionId,
  });
  const workflowLaunchAck = (transcriptDir: string) =>
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: WORKFLOW_TOOL_USE_ID,
            content: [{ type: "text", text: "Workflow launched." }],
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000001003",
      session_id: sessionId,
      tool_use_result: {
        taskType: "local_workflow",
        runId: "wf_probe",
        transcriptDir,
      },
    });
  const workflowSnapshot = (input: {
    readonly uuid: string;
    readonly state: "queued" | "start" | "done";
    readonly secondState?: "queued" | "start" | "done";
    readonly startedAt?: number;
    readonly lastProgressAt?: number;
    readonly durationMs?: number;
    readonly label?: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly attempt?: number;
    readonly omitResult?: boolean;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_progress",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      description: "Alpha: alpha:one",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Alpha" },
        {
          type: "workflow_agent",
          index: 1,
          label: input.label ?? "alpha:one",
          agentId: "a1",
          state: input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          model: input.model ?? "claude-opus-5[1m]",
          promptPreview: input.prompt ?? "Reply with exactly: A1",
          ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
          ...(input.lastProgressAt === undefined ? {} : { lastProgressAt: input.lastProgressAt }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          ...(input.state === "done" && input.omitResult !== true
            ? { resultPreview: "A1 excerpt" }
            : {}),
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "alpha:two",
          agentId: "a2",
          state: input.secondState ?? input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          promptPreview: "Reply with exactly: A2",
          ...(input.state === "done" ? { resultPreview: "A2 excerpt" } : {}),
        },
      ],
      uuid: input.uuid,
      session_id: sessionId,
    });
  const workflowNotification = (input: {
    readonly uuid: string;
    readonly status: "completed" | "failed" | "stopped";
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      status: input.status,
      summary: "Workflow finished.",
      output_file: "/tmp/workflow.output",
      uuid: input.uuid,
      session_id: sessionId,
    });
  return {
    workflowToolUse,
    workflowTaskStarted,
    workflowLaunchAck,
    workflowSnapshot,
    workflowNotification,
  };
}

export const workflowCoordinatorEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId === WORKFLOW_TASK_ID,
  );

export const workflowMemberEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  index: number,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId?.endsWith(`:agent:${index}`) === true,
  );

export const threadMessages = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
      event.type === "message.updated" && event.message.threadId === threadId,
  );
