import { claudeSdkFrame } from "./ClaudeWakeFrames.testkit.ts";

const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

export const monitorFrames = (index: number, nextUuid: () => string) => {
  const taskId = `monitor-task-${index}`;
  const toolUseId = `toolu_monitor_${index}`;
  const description = `Monitor ${index}`;
  return {
    taskId,
    start: [
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: `msg_monitor_${index}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: "Monitor",
              input: { description, command: "sleep 8 && echo MONITOR_DONE" },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        uuid: nextUuid(),
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        is_backgrounded: true,
        task_type: "local_bash",
        uuid: nextUuid(),
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Monitor started (task ${taskId}).`,
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: nextUuid(),
        session_id: WAKE_NATIVE_SESSION,
        tool_use_result: { taskId, persistent: false },
      }),
    ],
    end: claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: toolUseId,
      status: "completed",
      output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
      summary: `Monitor "${description}" stream ended`,
      uuid: nextUuid(),
      session_id: WAKE_NATIVE_SESSION,
    }),
  };
};
