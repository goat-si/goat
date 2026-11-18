import { isClaudeOpaqueBackgroundTaskType } from "./ClaudeBackgroundTasks.ts";
import {
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebSearchOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2TurnItem,
  type OrchestrationV2WebSearchResult,
  type ProviderRequestKind,
} from "@goat/contracts";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  mcpToolPresentation,
  normalizeMcpText,
} from "@goat/provider-core/server/mcpToolPresentation";
import { claudeFileChangePatch } from "../fileChangePatch.ts";
import { claudeFileChangeLineCounts } from "../fileChangeLineCounts.ts";

type ClaudeUserContent = SDKUserMessage["message"]["content"];
type ClaudeUserContentBlock = Exclude<ClaudeUserContent, string>[number];

type ClaudeAssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type ClaudeToolUseContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }
>;
type ClaudeAssistantToolResultContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
type ClaudeUserToolResultContentBlock = Extract<
  ClaudeUserContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
type ClaudeToolResultContentBlock =
  | ClaudeAssistantToolResultContentBlock
  | ClaudeUserToolResultContentBlock;
type ClaudeTypedToolResultContentBlock = Exclude<
  ClaudeToolResultContentBlock,
  { readonly type: "mcp_tool_result" | "tool_result" }
>;
type ClaudeTypedToolResultContent = ClaudeTypedToolResultContentBlock["content"];
type ClaudeToolResultOutput =
  | Extract<ClaudeToolResultContentBlock, { readonly type: "tool_result" }>["content"]
  | Extract<ClaudeToolResultContentBlock, { readonly type: "mcp_tool_result" }>["content"]
  | ClaudeTypedToolResultContent;

function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK variant: ${jsonStringifyForTool(value)}`);
}

type ClaudeToolItemType = Extract<
  OrchestrationV2TurnItem["type"],
  "command_execution" | "file_change" | "dynamic_tool" | "web_search"
>;

interface ClaudeToolClassification {
  readonly known: boolean;
  readonly normalizedName: string;
  readonly itemType: ClaudeToolItemType;
  readonly requestKind: ProviderRequestKind;
}

function normalizedClaudeToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
}

const CLAUDE_KNOWN_TOOL_CLASSIFICATIONS: Record<
  string,
  {
    readonly itemType: ClaudeToolItemType;
    readonly requestKind: ProviderRequestKind;
  }
> = {
  agent: { itemType: "dynamic_tool", requestKind: "command" },
  bash: { itemType: "command_execution", requestKind: "command" },
  edit: { itemType: "file_change", requestKind: "file-change" },
  glob: { itemType: "dynamic_tool", requestKind: "file-read" },
  grep: { itemType: "dynamic_tool", requestKind: "file-read" },
  ls: { itemType: "dynamic_tool", requestKind: "file-read" },
  monitor: { itemType: "dynamic_tool", requestKind: "command" },
  multiedit: { itemType: "file_change", requestKind: "file-change" },
  notebookedit: { itemType: "file_change", requestKind: "file-change" },
  read: { itemType: "dynamic_tool", requestKind: "file-read" },
  sendmessage: { itemType: "dynamic_tool", requestKind: "command" },
  task: { itemType: "dynamic_tool", requestKind: "command" },
  taskstop: { itemType: "dynamic_tool", requestKind: "command" },
  todowrite: { itemType: "dynamic_tool", requestKind: "command" },
  toolsearch: { itemType: "dynamic_tool", requestKind: "command" },
  webfetch: { itemType: "web_search", requestKind: "command" },
  websearch: { itemType: "web_search", requestKind: "command" },
  write: { itemType: "file_change", requestKind: "file-change" },
};

function classifyClaudeNativeTool(toolName: string): ClaudeToolClassification {
  const normalizedName = normalizedClaudeToolName(toolName);
  const known = CLAUDE_KNOWN_TOOL_CLASSIFICATIONS[normalizedName];
  return known === undefined
    ? {
        known: false,
        normalizedName,
        itemType: "dynamic_tool",
        requestKind: "command",
      }
    : {
        known: true,
        normalizedName,
        ...known,
      };
}

function providerRequestKindFromClaudeTool(toolName: string): ProviderRequestKind {
  return classifyClaudeNativeTool(toolName).requestKind;
}

function isClaudeWebSearchOutput(output: unknown): output is WebSearchOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    typeof Reflect.get(output, "query") === "string" &&
    Array.isArray(Reflect.get(output, "results")) &&
    typeof Reflect.get(output, "durationSeconds") === "number"
  );
}

const ClaudeNativeToolInputRecord = Schema.Record(Schema.String, Schema.Unknown);
type ClaudeNativeToolInputRecord = typeof ClaudeNativeToolInputRecord.Type;
const isClaudeNativeToolInputRecord = Schema.is(ClaudeNativeToolInputRecord);

type ClaudeNativeToolInput =
  | {
      readonly type: "record";
      readonly value: ClaudeNativeToolInputRecord;
    }
  | {
      readonly type: "non_record";
      readonly value: unknown;
    };

const EMPTY_CLAUDE_NATIVE_TOOL_INPUT = {
  type: "record",
  value: {},
} satisfies ClaudeNativeToolInput;

function claudeNativeToolInputFromUnknown(input: unknown): ClaudeNativeToolInput {
  return isClaudeNativeToolInputRecord(input)
    ? { type: "record", value: input }
    : { type: "non_record", value: input };
}

function claudeNativeToolInputFromRecord(input: Record<string, unknown>): ClaudeNativeToolInput {
  return { type: "record", value: input };
}

function claudeNativeToolInputValue(input: ClaudeNativeToolInput): unknown {
  return input.value;
}

function inputRecordValue(input: ClaudeNativeToolInput, key: string): unknown {
  return input.type === "record" ? input.value[key] : undefined;
}

function firstStringInputField(
  input: ClaudeNativeToolInput,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = inputRecordValue(input, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function jsonStringifyForTool(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function commandInputFromClaudeTool(toolName: string, input: ClaudeNativeToolInput): string {
  return (
    firstStringInputField(input, ["command", "cmd", "script"]) ??
    `${toolName}: ${jsonStringifyForTool(claudeNativeToolInputValue(input))}`
  );
}

// Claude Code 2.1.292 defers its goal Stop hook for these subagent types.
// local_bash tasks defer it through the opaque-task roster.
const CLAUDE_GOAL_DEFERRING_TASK_TYPES: ReadonlySet<string> = new Set([
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "local_workflow",
]);

function claudeTaskTypeFromSdkMessage(message: SDKMessage): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const taskType = Reflect.get(message, "task_type");
  return typeof taskType === "string" ? taskType : null;
}

function isClaudeNonSubagentTask(message: SDKMessage): boolean {
  return isClaudeOpaqueBackgroundTaskType(claudeTaskTypeFromSdkMessage(message));
}

function isClaudeBackgroundTasksChangedMessage(message: SDKMessage): boolean {
  return message.type === "system" && (message.subtype as string) === "background_tasks_changed";
}

function isClaudeTurnStartMessage(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "init";
}

function isClaudeRootTurnFrame(message: SDKMessage): boolean {
  return (
    isClaudeTurnStartMessage(message) ||
    ((message.type === "user" || message.type === "assistant" || message.type === "stream_event") &&
      message.parent_tool_use_id == null)
  );
}

// One stable id per native thread: a new ScheduleWakeup replaces the pending one.
const CLAUDE_SCHEDULED_WAKEUP_TASK: OrchestrationV2PendingBackgroundTask = {
  taskId: "claude-scheduled-wakeup",
  kind: "background_task",
  description: "Scheduled wakeup",
};

// Claude Code jitters one-shot wakeups early but never before the requested time, which is at
// most 60 s before the minute-rounded scheduledFor it reports; the rest is slack.
const CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS = 120_000;

function claudePendingBackgroundTasksFromRoster(
  roster: ReadonlyMap<string, OrchestrationV2PendingBackgroundTask>,
  awaitedTaskIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  return Array.from(roster.values(), (task) =>
    awaitedTaskIds.has(task.taskId) ? { ...task, awaited: true as const } : task,
  );
}

function fileNameFromClaudeTool(toolName: string, input: ClaudeNativeToolInput): string {
  return (
    firstStringInputField(input, ["file_path", "notebook_path", "path", "filename", "fileName"]) ??
    `${toolName} result`
  );
}

type ClaudeNativeToolOutput =
  | {
      readonly type: "none";
    }
  | {
      readonly type: "content_block";
      readonly value: ClaudeToolResultOutput;
    }
  | {
      readonly type: "structured_tool_use_result";
      readonly value: unknown;
      readonly fallbackValue?: ClaudeToolResultOutput;
    };

const NO_CLAUDE_NATIVE_TOOL_OUTPUT = { type: "none" } satisfies ClaudeNativeToolOutput;

function claudeNativeToolOutputFromToolResult(
  toolResult: ClaudeToolResultContentBlock,
): ClaudeNativeToolOutput {
  const value = outputFromClaudeToolResult(toolResult);
  return value === undefined ? NO_CLAUDE_NATIVE_TOOL_OUTPUT : { type: "content_block", value };
}

function claudeNativeToolOutputFromStructuredResult(input: {
  readonly structuredOutput: unknown;
  readonly fallbackValue?: ClaudeToolResultOutput;
}): ClaudeNativeToolOutput {
  return {
    type: "structured_tool_use_result",
    value: input.structuredOutput,
    ...(input.fallbackValue === undefined ? {} : { fallbackValue: input.fallbackValue }),
  };
}

function claudeNativeToolOutputValue(output: ClaudeNativeToolOutput): unknown | undefined {
  switch (output.type) {
    case "none":
      return undefined;
    case "content_block":
    case "structured_tool_use_result":
      return output.value;
    default:
      return assertNever(output);
  }
}

function claudeNativeToolOutputText(output: ClaudeNativeToolOutput): string {
  const value = claudeNativeToolOutputValue(output);
  return typeof value === "string" ? value : value === undefined ? "" : jsonStringifyForTool(value);
}

function claudeFileChangeArtifacts(
  fileName: string,
  result: unknown,
  workspaceRoot?: string | null,
) {
  const patch = claudeFileChangePatch(fileName, result, workspaceRoot);
  return { ...claudeFileChangeLineCounts(result), ...(patch === undefined ? {} : { patch }) };
}

const decodeClaudeFileEditResult = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    filePath: Schema.String,
    content: Schema.optional(Schema.String),
    structuredPatch: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          oldStart: Schema.Number,
          oldLines: Schema.Number,
          newStart: Schema.Number,
          newLines: Schema.Number,
          lines: Schema.mutable(Schema.Array(Schema.String)),
        }),
      ),
    ),
  }),
);

function claudeFileChangeText(output: ClaudeNativeToolOutput): string {
  const result =
    output.type === "structured_tool_use_result"
      ? Option.getOrUndefined(decodeClaudeFileEditResult(output.value))
      : undefined;
  if (result === undefined) return claudeNativeToolOutputText(output);
  const patch =
    result.structuredPatch.length === 0 && result.type === "create" && result.content !== undefined
      ? structuredPatch("/dev/null", result.filePath, "", result.content)
      : {
          oldFileName: result.filePath,
          newFileName: result.filePath,
          oldHeader: undefined,
          newHeader: undefined,
          hunks: result.structuredPatch,
        };
  return patch.hunks.length === 0 ? "" : formatPatch(patch, FILE_HEADERS_ONLY);
}

function claudeCommandOutputText(output: ClaudeNativeToolOutput): string {
  const value = claudeNativeToolOutputValue(output);
  if (typeof value === "object" && value !== null) {
    const stdout = Reflect.get(value, "stdout");
    const stderr = Reflect.get(value, "stderr");
    if (typeof stdout === "string" || typeof stderr === "string") {
      const out = typeof stdout === "string" && stdout.trim().length > 0 ? stdout : "";
      const err = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : "";
      // Claude trims each stream's trailing newline, so stderr may need one to start its line.
      const text =
        out.length > 0 && err.length > 0 && !out.endsWith("\n") ? `${out}\n${err}` : out + err;
      if (text.length > 0) return text;
      return output.type === "structured_tool_use_result" && output.fallbackValue !== undefined
        ? claudeSubagentResultText({ type: "content_block", value: output.fallbackValue })
        : "";
    }
  }
  return claudeNativeToolOutputText(output);
}

// Claude Code prefixes foreground Agent results with a note for the parent model, not the report.
const CLAUDE_TOOLS_USED_NOTE =
  /^\s*<tools-used-before-summary>[^<]*<\/tools-used-before-summary>\s*/;

function claudeSubagentResultText(output: ClaudeNativeToolOutput): string {
  return claudeSubagentRawResultText(output).replace(CLAUDE_TOOLS_USED_NOTE, "");
}

function claudeSubagentRawResultText(output: ClaudeNativeToolOutput): string {
  const value = claudeNativeToolOutputValue(output);
  const content = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "content" in value
      ? value.content
      : undefined;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("\n");
    if (text.length > 0) {
      return text;
    }
  }
  return claudeNativeToolOutputText(output);
}

function isClaudeSubagentAsyncLaunchAck(output: ClaudeNativeToolOutput): boolean {
  const value = claudeNativeToolOutputValue(output);
  if (typeof value === "object" && value !== null) {
    if ("isAsync" in value && value.isAsync === true) {
      return true;
    }
    if ("status" in value && value.status === "async_launched") {
      return true;
    }
  }
  return claudeSubagentResultText(output).startsWith("Async agent launched successfully.");
}

const WEB_FETCH_SNIPPET_MAX_CHARS = 8_000;

function webSearchPatternsFromClaudeTool(input: {
  readonly toolInput: ClaudeNativeToolInput;
  readonly output: ClaudeNativeToolOutput;
}): ReadonlyArray<string> {
  const output = claudeNativeToolOutputValue(input.output);
  const pattern =
    firstStringInputField(input.toolInput, ["query", "url", "pattern"]) ??
    (isClaudeWebSearchOutput(output) ? output.query : undefined);
  return pattern === undefined || pattern.trim().length === 0 ? [] : [pattern];
}

function webSearchResultsFromClaudeOutput(
  output: ClaudeNativeToolOutput,
): ReadonlyArray<OrchestrationV2WebSearchResult> {
  const value = claudeNativeToolOutputValue(output);
  if (!isClaudeWebSearchOutput(value)) {
    return [];
  }

  return value.results.flatMap((result) => {
    if (typeof result === "string") {
      return [];
    }
    return result.content.map((content) => ({
      title: content.title,
      url: content.url,
    }));
  });
}

function summarizeClaudeToolRequest(toolName: string, input: ClaudeNativeToolInput): string {
  const command = firstStringInputField(input, ["command", "cmd", "script"]);
  if (command !== undefined) {
    return `${toolName}: ${command.slice(0, 400)}`;
  }
  const path = firstStringInputField(input, ["file_path", "path", "filename", "fileName"]);
  if (path !== undefined) {
    return `${toolName}: ${path.slice(0, 400)}`;
  }
  const serialized = jsonStringifyForTool(claudeNativeToolInputValue(input));
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

function outputFromClaudeToolResult(
  toolResult: ClaudeToolResultContentBlock,
): ClaudeToolResultOutput | undefined {
  switch (toolResult.type) {
    case "tool_result":
      return toolResult.content;
    case "mcp_tool_result":
      return toolResult.content;
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "advisor_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return toolResult.content;
    default:
      return assertNever(toolResult);
  }
}

function isClaudeTypedToolResultErrorContent(content: ClaudeTypedToolResultContent): boolean {
  if (Array.isArray(content)) {
    return false;
  }

  switch (content.type) {
    case "advisor_tool_result_error":
    case "bash_code_execution_tool_result_error":
    case "code_execution_tool_result_error":
    case "text_editor_code_execution_tool_result_error":
    case "tool_search_tool_result_error":
    case "web_fetch_tool_result_error":
    case "web_search_tool_result_error":
      return true;
    default:
      return false;
  }
}

function isClaudeToolResultError(toolResult: ClaudeToolResultContentBlock): boolean {
  switch (toolResult.type) {
    case "tool_result":
      return toolResult.is_error === true;
    case "mcp_tool_result":
      return toolResult.is_error;
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "advisor_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return isClaudeTypedToolResultErrorContent(toolResult.content);
    default:
      return assertNever(toolResult);
  }
}

function toolNameFromClaudeToolResult(toolResult: ClaudeToolResultContentBlock): string {
  switch (toolResult.type) {
    case "bash_code_execution_tool_result":
      return "bash_code_execution";
    case "code_execution_tool_result":
      return "code_execution";
    case "advisor_tool_result":
      return "advisor";
    case "mcp_tool_result":
      return "mcp_tool";
    case "text_editor_code_execution_tool_result":
      return "text_editor_code_execution";
    case "tool_result":
      return "tool";
    case "tool_search_tool_result":
      return "tool_search";
    case "web_fetch_tool_result":
      return "web_fetch";
    case "web_search_tool_result":
      return "web_search";
    default:
      return assertNever(toolResult);
  }
}

function isClaudeAssistantToolResultContentBlock(
  part: ClaudeAssistantContentBlock,
): part is ClaudeAssistantToolResultContentBlock {
  return "tool_use_id" in part && typeof part.tool_use_id === "string";
}

function isClaudeUserToolResultContentBlock(
  part: ClaudeUserContentBlock,
): part is ClaudeUserToolResultContentBlock {
  return "tool_use_id" in part && typeof part.tool_use_id === "string";
}

function isClaudeToolUseContentBlock(
  part: ClaudeAssistantContentBlock,
): part is ClaudeToolUseContentBlock {
  return (
    "id" in part &&
    typeof part.id === "string" &&
    "name" in part &&
    typeof part.name === "string" &&
    "input" in part
  );
}

function claudeToolUseBlocksFromAssistantMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolUseContentBlock> {
  if (message.type !== "assistant") {
    return [];
  }
  return message.message.content.filter(isClaudeToolUseContentBlock);
}

type ClaudeToolPresentation = ReturnType<typeof mcpToolPresentation>;

function claudeToolPresentationsFromAssistantMessage(
  message: SDKMessage,
): ReadonlyMap<string, ClaudeToolPresentation> {
  const presentations = new Map<string, ClaudeToolPresentation>();
  const meta = message.type === "assistant" ? Reflect.get(message, "tool_use_meta") : undefined;
  if (!Array.isArray(meta)) return presentations;
  const toolNames = new Map(
    claudeToolUseBlocksFromAssistantMessage(message).map((tool) => [
      tool.id,
      tool.name.replace(/^mcp__claude_ai_/u, "mcp__"),
    ]),
  );
  for (const entry of meta) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = normalizeMcpText(Reflect.get(entry, "id"), 512);
    if (id === undefined) continue;
    presentations.set(
      id,
      mcpToolPresentation({
        toolName: toolNames.get(id),
        title: Reflect.get(entry, "display_name"),
        serverDisplayName: Reflect.get(entry, "server_display_name"),
        iconUrl: Reflect.get(entry, "icon_url"),
      }),
    );
  }
  return presentations;
}

function claudeToolResultBlocksFromAssistantMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolResultContentBlock> {
  if (message.type !== "assistant") {
    return [];
  }
  return message.message.content.filter(isClaudeAssistantToolResultContentBlock);
}

function claudeToolResultBlocksFromUserMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolResultContentBlock> {
  if (message.type !== "user" || typeof message.message.content === "string") {
    return [];
  }
  return message.message.content.filter(isClaudeUserToolResultContentBlock);
}

function claudeToolResultEntriesFromMessage(message: SDKMessage): ReadonlyArray<{
  readonly toolResult: ClaudeToolResultContentBlock;
  readonly output: ClaudeNativeToolOutput;
}> {
  const assistantResults = claudeToolResultBlocksFromAssistantMessage(message).map(
    (toolResult) => ({ toolResult, output: claudeNativeToolOutputFromToolResult(toolResult) }),
  );
  const userResults = claudeToolResultBlocksFromUserMessage(message);
  const structuredOutput =
    message.type === "user" && userResults.length === 1 ? message.tool_use_result : undefined;
  return [
    ...assistantResults,
    ...userResults.map((toolResult) => ({
      toolResult,
      output:
        structuredOutput === undefined
          ? claudeNativeToolOutputFromToolResult(toolResult)
          : claudeNativeToolOutputFromStructuredResult({
              structuredOutput,
              fallbackValue: outputFromClaudeToolResult(toolResult),
            }),
    })),
  ];
}

const ClaudeToolResultMetadata = Schema.Struct({
  tool_result_meta: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      non_execution_kind: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const isClaudeToolResultMetadata = Schema.is(ClaudeToolResultMetadata);

function claudeToolNonExecutionKind(message: SDKMessage, toolUseId: string) {
  return isClaudeToolResultMetadata(message)
    ? (message.tool_result_meta.find((meta) => meta.id === toolUseId)?.non_execution_kind ??
        undefined)
    : undefined;
}

function parentToolUseIdFromSdkMessage(message: SDKMessage): string | null {
  return message.type === "assistant" || message.type === "user"
    ? message.parent_tool_use_id
    : null;
}

export {
  CLAUDE_GOAL_DEFERRING_TASK_TYPES,
  CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS,
  CLAUDE_SCHEDULED_WAKEUP_TASK,
  EMPTY_CLAUDE_NATIVE_TOOL_INPUT,
  NO_CLAUDE_NATIVE_TOOL_OUTPUT,
  WEB_FETCH_SNIPPET_MAX_CHARS,
  classifyClaudeNativeTool,
  claudeCommandOutputText,
  claudeFileChangeArtifacts,
  claudeFileChangeText,
  claudeNativeToolInputFromRecord,
  claudeNativeToolInputFromUnknown,
  claudeNativeToolInputValue,
  claudeNativeToolOutputText,
  claudeNativeToolOutputValue,
  claudePendingBackgroundTasksFromRoster,
  claudeSubagentResultText,
  claudeTaskTypeFromSdkMessage,
  claudeToolNonExecutionKind,
  claudeToolPresentationsFromAssistantMessage,
  claudeToolResultBlocksFromAssistantMessage,
  claudeToolResultBlocksFromUserMessage,
  claudeToolResultEntriesFromMessage,
  claudeToolUseBlocksFromAssistantMessage,
  commandInputFromClaudeTool,
  fileNameFromClaudeTool,
  firstStringInputField,
  inputRecordValue,
  isClaudeBackgroundTasksChangedMessage,
  isClaudeNonSubagentTask,
  isClaudeRootTurnFrame,
  isClaudeSubagentAsyncLaunchAck,
  isClaudeToolResultError,
  isClaudeTurnStartMessage,
  parentToolUseIdFromSdkMessage,
  providerRequestKindFromClaudeTool,
  summarizeClaudeToolRequest,
  toolNameFromClaudeToolResult,
  webSearchPatternsFromClaudeTool,
  webSearchResultsFromClaudeOutput,
};

export type {
  ClaudeNativeToolInput,
  ClaudeNativeToolOutput,
  ClaudeToolClassification,
  ClaudeToolPresentation,
  ClaudeToolResultContentBlock,
  ClaudeUserContentBlock,
};
