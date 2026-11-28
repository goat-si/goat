import type { AcpSubagentTranscriptEntry } from "@goat/provider-acp/server/adapter";
import type { AcpToolCallState } from "@goat/provider-acp/server/runtimeModel";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  AntigravityChildWorkReadError,
  BATCH_TRANSCRIPT_BYTES,
  NATIVE_ID,
  STEP_TEXT_CAP,
  TRANSCRIPT_BYTE_CAP,
  capText,
  readChildTranscriptRaw,
  resolveAntigravityInvokeRecord,
  toolArguments,
  type BatchLaunch,
} from "./AntigravityChildWork.ts";
import { antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import { boundAntigravityToolText, sanitizeAntigravityToolPayload } from "./AntigravityProtocol.ts";

const TranscriptLine = Schema.Struct({
  step_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.optional(Schema.String),
  type: Schema.String,
  status: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })),
  ),
});
type TranscriptStep = Schema.Schema.Type<typeof TranscriptLine>;
const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

const REASONING_TEXT_CAP = 16_000;
const ASSISTANT_TEXT_CAP = 32_000;
const TOOL_OUTPUT_CAP = 8_000;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
]);
const EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "write_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);
const EXECUTE_TOOL_NAMES = new Set(["run_command", "bash", "shell"]);
const FILE_SEARCH_TOOL_NAMES = new Set(["grep_search", "find_by_name", "glob", "ripgrep"]);
const WEB_SEARCH_TOOL_NAMES = new Set(["search_web", "web_search"]);
const WEB_FETCH_TOOL_NAMES = new Set(["read_url_content", "fetch_url"]);

const NON_TOOL_RESULT_STEP_TYPES = new Set([
  "PLANNER_RESPONSE",
  "SYSTEM_MESSAGE",
  "USER_INPUT",
  "CHECKPOINT",
  "ERROR_MESSAGE",
]);

function parseTranscriptTimestamp(value: string | undefined): DateTime.Utc | undefined {
  return value === undefined ? undefined : Option.getOrUndefined(DateTime.make(value));
}

function stringField(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function rawStringField(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

// Linear scan: transcript content is untrusted and can be hundreds of KiB, so no backtracking regex.
function deliveredSystemMessageBody(content: string): string | undefined {
  const openTag = "<SYSTEM_MESSAGE>";
  for (
    let open = content.indexOf(openTag);
    open !== -1;
    open = content.indexOf(openTag, open + 1)
  ) {
    let start = open + openTag.length;
    let sawNewline = false;
    while (start < content.length) {
      const ch = content[start];
      if (ch === undefined || !/\s/u.test(ch)) break;
      if (ch === "\n") sawNewline = true;
      start += 1;
    }
    if (!sawNewline || !content.startsWith("[Message]", start)) continue;
    const close = content.indexOf("</SYSTEM_MESSAGE>", start);
    return content.slice(start, close === -1 ? undefined : close).trim();
  }
  return undefined;
}

/** Extracts the delivered body from an inter-agent `<SYSTEM_MESSAGE>[Message] ... content=...</SYSTEM_MESSAGE>`. */
function extractDeliveredSystemMessage(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const inner =
    deliveredSystemMessageBody(content) ??
    (content.trimStart().startsWith("[Message]") ? content.trim() : undefined);
  if (inner === undefined) return undefined;
  const contentMarker = " content=";
  const contentIndex = inner.indexOf(contentMarker);
  if (contentIndex === -1) return undefined;
  const text = inner.slice(contentIndex + contentMarker.length).trim();
  return text.length > 0 ? text : undefined;
}

/** Strips Antigravity's repeated `Created At:` / `Completed At:` header lines from `GENERIC` outputs. */
function cleanToolResultContent(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const lines = content.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length && /^(?:Created At|Completed At):\s+/u.test(lines[index] ?? "")) {
    index += 1;
  }
  const cleaned = lines.slice(index).join("\n").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function transcriptStepToolStatus(
  resultStep: TranscriptStep | undefined,
  finalize: boolean,
): {
  readonly status: NonNullable<AcpToolCallState["status"]>;
  readonly projectedStatus?: "interrupted" | undefined;
} {
  if (resultStep === undefined) {
    return finalize
      ? { status: "failed", projectedStatus: "interrupted" }
      : { status: "inProgress" };
  }
  const normalized = resultStep.status?.trim().toUpperCase();
  if (
    normalized === "ERROR" ||
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "CANCELLED"
  ) {
    return { status: "failed" };
  }
  if (normalized === "RUNNING" || normalized === "PENDING" || normalized === "IN_PROGRESS") {
    return finalize
      ? { status: "failed", projectedStatus: "interrupted" }
      : { status: "inProgress" };
  }
  return { status: "completed" };
}

function transcriptToolCallToAcpState(input: {
  readonly toolCallId: string;
  readonly call: NonNullable<TranscriptStep["tool_calls"]>[number];
  readonly resultStep: TranscriptStep | undefined;
  readonly finalize: boolean;
}): {
  readonly toolCall: AcpToolCallState;
  readonly projectedStatus?: "interrupted" | undefined;
} {
  const decodedArgs = toolArguments(input.call.args);
  const rawInput = Predicate.isObject(decodedArgs)
    ? (decodedArgs as Record<string, unknown>)
    : undefined;
  const { status, projectedStatus } = transcriptStepToolStatus(input.resultStep, input.finalize);
  const errorText = input.resultStep?.error?.trim();
  const contentText = cleanToolResultContent(input.resultStep?.content);
  const outputText =
    status === "failed" ? errorText || contentText : (contentText ?? (errorText || undefined));
  const boundedOutput =
    outputText === undefined ? undefined : boundAntigravityToolText(outputText, TOOL_OUTPUT_CAP);
  const sanitizedInput = sanitizeAntigravityToolPayload(rawInput ?? decodedArgs);
  const sanitizedInputRecord = Predicate.isObject(sanitizedInput)
    ? (sanitizedInput as Record<string, unknown>)
    : undefined;
  const toolSummary = stringField(rawInput, ["toolSummary"]);
  const name = input.call.name.trim();
  const lower = name.toLowerCase();

  if (READ_TOOL_NAMES.has(lower)) {
    const targetPath = stringField(rawInput, [
      "Path",
      "AbsolutePath",
      "File",
      "DirectoryPath",
      "path",
      "file_path",
      "filePath",
    ]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "read",
        status,
        ...(targetPath === undefined ? { title: toolSummary ?? name } : {}),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(targetPath === undefined ? {} : { locations: [{ path: targetPath }] }),
        },
      },
    };
  }

  if (EDIT_TOOL_NAMES.has(lower)) {
    const targetPath = stringField(rawInput, [
      "Path",
      "TargetFile",
      "AbsolutePath",
      "path",
      "file_path",
      "filePath",
    ]);
    const oldText = rawStringField(rawInput, ["Target", "TargetContent", "old_str", "oldText"]);
    const newText = rawStringField(rawInput, [
      "Replacement",
      "ReplacementContent",
      "Content",
      "CodeContent",
      "new_str",
      "newText",
    ]);
    const diffContent =
      targetPath !== undefined && newText !== undefined
        ? [
            {
              type: "diff",
              path: targetPath,
              ...(oldText === undefined
                ? {}
                : { oldText: boundAntigravityToolText(oldText, TOOL_OUTPUT_CAP) }),
              newText: boundAntigravityToolText(newText, TOOL_OUTPUT_CAP),
            },
          ]
        : undefined;
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "edit",
        status,
        ...(targetPath === undefined ? { title: toolSummary ?? name } : {}),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(targetPath === undefined ? {} : { locations: [{ path: targetPath }] }),
          ...(diffContent === undefined ? {} : { content: diffContent }),
        },
      },
    };
  }

  if (EXECUTE_TOOL_NAMES.has(lower)) {
    const command = stringField(rawInput, [
      "CommandLine",
      "command_line",
      "commandLine",
      "command",
    ]);
    const cwd = stringField(rawInput, [
      "Cwd",
      "WorkingDirectory",
      "working_dir",
      "workingDir",
      "cwd",
    ]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "execute",
        status,
        title: toolSummary ?? command ?? name,
        ...(command === undefined ? {} : { command }),
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(command === undefined ? {} : { command }),
          ...(cwd === undefined ? {} : { cwd }),
        },
      },
    };
  }

  if (FILE_SEARCH_TOOL_NAMES.has(lower)) {
    const query = stringField(rawInput, ["Query", "Pattern", "query", "pattern"]);
    const searchPath = stringField(rawInput, [
      "SearchPath",
      "SearchDirectory",
      "DirectoryPath",
      "path",
      "Path",
    ]);
    const normalizedInput = {
      ...sanitizedInputRecord,
      ...(query === undefined ? {} : { query, pattern: query }),
      ...(searchPath === undefined ? {} : { path: searchPath }),
    };
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "search",
        status,
        ...(toolSummary === undefined ? {} : { title: toolSummary }),
        data: {
          rawInput: normalizedInput,
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(searchPath === undefined ? {} : { locations: [{ path: searchPath }] }),
        },
      },
    };
  }

  if (WEB_SEARCH_TOOL_NAMES.has(lower)) {
    const query = stringField(rawInput, ["query", "Query", "search_query", "q"]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "search",
        status,
        title: "Web search",
        data: {
          title: "Web search",
          rawInput: {
            ...sanitizedInputRecord,
            ...(query === undefined ? {} : { query }),
          },
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
        },
      },
    };
  }

  if (WEB_FETCH_TOOL_NAMES.has(lower)) {
    const url = stringField(rawInput, ["Url", "url", "URL"]);
    return {
      projectedStatus,
      toolCall: {
        toolCallId: input.toolCallId,
        kind: "fetch",
        status,
        title: toolSummary ?? name,
        data: {
          ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
          ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
          ...(url === undefined ? {} : { locations: [{ path: url }] }),
        },
      },
    };
  }

  const title = name.startsWith("mcp_") ? `Run ${name}` : (toolSummary ?? name);
  return {
    projectedStatus,
    toolCall: {
      toolCallId: input.toolCallId,
      kind: "other",
      status,
      title,
      data: {
        ...(sanitizedInput === undefined ? {} : { rawInput: sanitizedInput }),
        ...(boundedOutput === undefined ? {} : { rawOutput: boundedOutput }),
      },
    },
  };
}

/**
 * Projects an Antigravity child conversation's `transcript.jsonl` into standard ACP subagent
 * timeline entries (thinking, typed tool calls paired with their results, follow-up user messages,
 * assistant messages, and errors).
 */
export function transcriptToSubagentEntries(
  contents: string,
  options: {
    readonly prompt: string;
    readonly childPrefix?: string | undefined;
    readonly childLabel?: string | undefined;
    readonly finalize?: boolean | undefined;
  },
): ReadonlyArray<AcpSubagentTranscriptEntry> {
  const steps = contents.split("\n").flatMap((line) => {
    const decoded = decodeTranscriptLine(line);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const prefix = options.childPrefix ?? "";
  const label = options.childLabel?.trim() || undefined;
  const finalize = options.finalize === true;
  const launchPrompt = options.prompt.trim();
  const entries: Array<AcpSubagentTranscriptEntry> = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    const createdAt = parseTranscriptTimestamp(step.created_at);

    if (step.type === "CHECKPOINT") continue;

    if (step.type === "SYSTEM_MESSAGE") {
      if (
        step.step_index === 0 &&
        (launchPrompt === "" || step.content?.includes(launchPrompt) === true)
      ) {
        continue;
      }
      const delivered = extractDeliveredSystemMessage(step.content);
      if (delivered !== undefined) {
        entries.push({
          kind: "user_message",
          itemId: `${prefix}step:${step.step_index}:user`,
          text: capText(delivered, ASSISTANT_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "USER_INPUT") {
      const text = step.content?.trim();
      if (text) {
        entries.push({
          kind: "user_message",
          itemId: `${prefix}step:${step.step_index}:user`,
          text: capText(text, ASSISTANT_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "ERROR_MESSAGE") {
      const message = (step.error ?? step.content ?? "").trim();
      if (message) {
        entries.push({
          kind: "error",
          itemId: `${prefix}step:${step.step_index}:error`,
          message: capText(message, STEP_TEXT_CAP),
          createdAt,
        });
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      const thinking = step.thinking?.trim();
      if (thinking) {
        const stepStatus = step.status?.trim().toUpperCase();
        const running =
          !finalize &&
          (stepStatus === "RUNNING" || stepStatus === "PENDING" || stepStatus === "IN_PROGRESS");
        entries.push({
          kind: "reasoning",
          itemId: `${prefix}step:${step.step_index}:thinking`,
          title: label ? `${label} · Thinking` : "Thinking",
          text: capText(thinking, REASONING_TEXT_CAP),
          status: running ? "running" : "completed",
          createdAt,
        });
      }

      const content = step.content?.trim();
      if (content) {
        const capped = capText(content, ASSISTANT_TEXT_CAP);
        entries.push({
          kind: "assistant_message",
          itemId: `${prefix}step:${step.step_index}:assistant`,
          text: label ? `**${label}**\n\n${capped}` : capped,
          createdAt,
        });
      }

      const calls = step.tool_calls ?? [];
      if (calls.length > 0) {
        // Pair each tool call 1-to-1 with the following tool-result steps until the next turn boundary.
        const resultSteps: Array<TranscriptStep> = [];
        let cursor = index + 1;
        while (cursor < steps.length && resultSteps.length < calls.length) {
          const candidate = steps[cursor];
          if (candidate === undefined) break;
          if (candidate.type === "CHECKPOINT") {
            cursor += 1;
            continue;
          }
          if (NON_TOOL_RESULT_STEP_TYPES.has(candidate.type)) break;
          resultSteps.push(candidate);
          cursor += 1;
        }
        index = cursor - 1;

        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
          const call = calls[callIndex];
          if (call === undefined) continue;
          const resultStep = resultSteps[callIndex];
          const itemId = `${prefix}step:${step.step_index}:tool:${callIndex}`;
          const { toolCall, projectedStatus } = transcriptToolCallToAcpState({
            toolCallId: itemId,
            call,
            resultStep,
            finalize,
          });
          entries.push({
            kind: "tool",
            itemId,
            toolCall,
            ...(projectedStatus === undefined ? {} : { projectedStatus }),
            createdAt: parseTranscriptTimestamp(resultStep?.created_at) ?? createdAt,
          });
        }
      }
      continue;
    }

    // Any standalone error step outside a planner response still surfaces visibly.
    if (step.status?.trim().toUpperCase() === "ERROR") {
      const message = (step.error ?? cleanToolResultContent(step.content) ?? "").trim();
      if (message) {
        entries.push({
          kind: "error",
          itemId: `${prefix}step:${step.step_index}:error`,
          message: capText(message, STEP_TEXT_CAP),
          createdAt,
        });
      }
    }
  }

  return entries;
}

/**
 * Reads standard timeline entries (thinking, typed tool calls, messages, errors) from the native
 * Antigravity child transcript(s) launched by a subagent call. Fails closed to an empty array.
 */
export const readAntigravitySubagentTranscript = Effect.fn("readAntigravitySubagentTranscript")(
  function* (input: {
    readonly profileDirectory: string;
    readonly rootSessionId: string;
    readonly nativeTaskId: string;
    readonly childSessionId?: string | null | undefined;
    readonly launch: BatchLaunch;
    readonly siblings: ReadonlyArray<BatchLaunch & { readonly nativeTaskId: string }>;
    readonly finalize?: boolean | undefined;
  }): Effect.fn.Return<ReadonlyArray<AcpSubagentTranscriptEntry>> {
    if (!NATIVE_ID.test(input.rootSessionId)) return [];
    const read = async (): Promise<ReadonlyArray<AcpSubagentTranscriptEntry>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return [];
      const record = await resolveAntigravityInvokeRecord(profileRoot, input);
      if (record === undefined) return [];
      const { launches, children } = record;
      const byteCap = Math.min(
        TRANSCRIPT_BYTE_CAP,
        Math.floor(BATCH_TRANSCRIPT_BYTES / Math.max(1, children.length)),
      );
      const multiChild = children.length > 1;
      const perChild = await Promise.all(
        children.map(async (child, index) => {
          const raw = await readChildTranscriptRaw(profileRoot, child, byteCap).catch(
            () => undefined,
          );
          if (raw === undefined || raw.contents.length === 0) return [];
          const launch = launches[index];
          // Prefix even a lone child, so its item ids hold when a sibling appears later.
          return transcriptToSubagentEntries(raw.contents, {
            prompt: launch?.prompt ?? input.launch.prompt,
            childPrefix: `${child.conversationId}:`,
            childLabel: multiChild ? launch?.role || child.conversationId : undefined,
            finalize: input.finalize,
          }).map((entry) => ({ ...entry, childKey: child.conversationId }));
        }),
      );
      if (!multiChild) return perChild.flat();
      // Undated entries inherit their child's previous timestamp so the comparator stays total.
      return perChild
        .flatMap((entries) => {
          let lastMs = 0;
          return entries.map((entry) => {
            lastMs =
              entry.createdAt === undefined ? lastMs : DateTime.toEpochMillis(entry.createdAt);
            return { entry, ms: lastMs };
          });
        })
        .map((keyed, position) => ({ ...keyed, position }))
        .sort((left, right) => left.ms - right.ms || left.position - right.position)
        .map(({ entry }) => entry);
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityChildWorkReadError({ cause }),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<AcpSubagentTranscriptEntry> => []));
  },
);
