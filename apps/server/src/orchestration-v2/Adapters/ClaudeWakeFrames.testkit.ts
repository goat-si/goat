import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
export const WAKE_TASK_ID = "bdqirlcyw";
export const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";
export const WAKE_TASK_DESCRIPTION = "Background sleep test";
export const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';
export const WAKE_ASSISTANT_TEXT = "WAKE_DONE";
export const WAKE_RESULT_TEXT = "WAKE_DONE";

export function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

export const wakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  description: WAKE_TASK_DESCRIPTION,
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000101",
  session_id: WAKE_NATIVE_SESSION,
});
export const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeAssistantErrorFrame = (input: {
  readonly uuid: string;
  readonly error:
    | "authentication_failed"
    | "invalid_request"
    | "rate_limit"
    | "server_error"
    | undefined;
  readonly text?: string;
  readonly parentToolUseId?: string | null;
  readonly apiErrorParams?: unknown;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text ?? "Claude could not complete this request." }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: input.parentToolUseId ?? null,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.apiErrorParams === undefined ? {} : { api_error_params: input.apiErrorParams }),
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly numTurns?: number;
  readonly origin?: { readonly kind: "task-notification" };
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly errors?: ReadonlyArray<string>;
  readonly apiErrorStatus?: number;
  // null omits the field, as the CLI does on a zero-turn result.
  readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
}) =>
  claudeSdkFrame({
    type: "result",
    subtype: input.subtype ?? "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: input.isError ?? false,
    num_turns: input.numTurns ?? 1,
    result: input.result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: input.usage ?? {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
    ...(input.terminalReason === null
      ? {}
      : { terminal_reason: input.terminalReason ?? "completed" }),
  });
export const turnOneResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000102",
  result: "Kicked off the build in the background.",
});
export const wakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  status: "completed",
  output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
  summary: WAKE_SUMMARY,
  uuid: "00000000-0000-4000-8000-000000000103",
  session_id: WAKE_NATIVE_SESSION,
});
export const wakeAssistant = makeAssistantTextFrame({
  uuid: "00000000-0000-4000-8000-000000000107",
  text: WAKE_ASSISTANT_TEXT,
});
export const wakeTurnInit = claudeSdkFrame({
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000110",
  session_id: WAKE_NATIVE_SESSION,
});
export const wakeResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000104",
  result: WAKE_RESULT_TEXT,
  origin: { kind: "task-notification" },
});
export const STALE_TASK_NOTIFICATION_RESULT_TEXT =
  "Stale task-notification origin text that must not appear.";
export const staleTaskNotificationResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000106",
  result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
  numTurns: 0,
  origin: { kind: "task-notification" },
  terminalReason: null,
});
