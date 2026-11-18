import type { OrchestrationV2ExecutionNode, OrchestrationV2TurnItem } from "@goat/contracts";
import type { IdAllocatorV2Derive } from "@goat/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@goat/provider-core/server/ProviderAdapter";
import { mcpToolPresentation } from "@goat/provider-core/server/mcpToolPresentation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import { CURSOR_PROVIDER } from "./CursorAgentSdk.ts";
import type {
  ActiveCursorToolCall,
  ActiveCursorTextSegment,
  CursorProjectionTarget,
} from "./activeTurn.ts";
import { formatReadToolLabel, formatSearchToolLabel } from "@goat/shared/toolActivity";
import { cursorToolOutput } from "./toolOutput.ts";
import {
  cursorToolFailed,
  cursorToolOutputText,
  cursorToolName,
  cursorToolFileName,
  cursorToolSearchPattern,
  cursorToolSearchResults,
} from "./toolPresentation.ts";
import type { makeTaskTextSnapshots } from "./taskTextSnapshots.ts";

export const MAX_CURSOR_STREAMED_OUTPUT_CHARS = 256 * 1024;

export function makeCursorTurnProjection(
  derive: IdAllocatorV2Derive,
  path: Path.Path,
  emitProviderEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
  taskTextSnapshots: ReturnType<typeof makeTaskTextSnapshots>,
) {
  const emitTextSnapshot = Effect.fnUntraced(function* (
    target: CursorProjectionTarget,
    itemId: string,
    completed: boolean,
    events: readonly [ProviderAdapterV2Event, ...ProviderAdapterV2Event[]],
  ) {
    if (target.runId === null) {
      if (!completed) return yield* taskTextSnapshots.offer(itemId, events);
      taskTextSnapshots.seal(itemId);
    }
    for (const event of events) yield* emitProviderEvent(event);
  });

  const emitAssistant = Effect.fnUntraced(function* (
    target: CursorProjectionTarget,
    segment: ActiveCursorTextSegment | null,
    completed: boolean,
  ) {
    if (segment === null || segment.text.length === 0) {
      return;
    }
    const now = yield* DateTime.now;
    const nodeId = derive.nodeFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: segment.nativeItemId,
    });
    const messageId = derive.messageFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: segment.nativeItemId,
    });
    const turnItemId = derive.turnItemFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: segment.nativeItemId,
    });
    const nativeItemRef = {
      driver: CURSOR_PROVIDER,
      nativeId: segment.nativeItemId,
      strength: "weak" as const,
    };
    const nodeEvent: ProviderAdapterV2Event = {
      type: "node.updated",
      driver: CURSOR_PROVIDER,
      node: {
        id: nodeId,
        threadId: target.threadId,
        runId: target.runId,
        parentNodeId: target.parentNodeId,
        rootNodeId: target.rootNodeId,
        kind: "assistant_message",
        status: completed ? "completed" : "running",
        countsForRun: false,
        providerThreadId: target.providerThreadId,
        providerTurnId: target.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: segment.startedAt,
        completedAt: completed ? now : null,
      },
    };
    const messageEvent: ProviderAdapterV2Event = {
      type: "message.updated",
      driver: CURSOR_PROVIDER,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: target.threadId,
        runId: target.runId,
        nodeId,
        role: "assistant",
        text: segment.text,
        attachments: [],
        streaming: !completed,
        createdAt: segment.startedAt,
        updatedAt: now,
      },
    };
    const itemEvent: ProviderAdapterV2Event = {
      type: "turn_item.updated",
      driver: CURSOR_PROVIDER,
      turnItem: {
        id: turnItemId,
        threadId: target.threadId,
        runId: target.runId,
        nodeId,
        providerThreadId: target.providerThreadId,
        providerTurnId: target.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: segment.ordinal,
        status: completed ? "completed" : "running",
        title: null,
        startedAt: segment.startedAt,
        completedAt: completed ? now : null,
        updatedAt: now,
        type: "assistant_message",
        messageId,
        text: segment.text,
        streaming: !completed,
      },
    };
    yield* emitTextSnapshot(target, segment.nativeItemId, completed, [
      nodeEvent,
      messageEvent,
      itemEvent,
    ]);
  });

  const emitReasoning = Effect.fnUntraced(function* (
    target: CursorProjectionTarget,
    segment: ActiveCursorTextSegment | null,
    completed: boolean,
  ) {
    if (segment === null || segment.text.length === 0) {
      return;
    }
    const now = yield* DateTime.now;
    const nodeId = derive.nodeFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: segment.nativeItemId,
    });
    const turnItemId = derive.turnItemFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: segment.nativeItemId,
    });
    const nativeItemRef = {
      driver: CURSOR_PROVIDER,
      nativeId: segment.nativeItemId,
      strength: "weak" as const,
    };
    const nodeEvent: ProviderAdapterV2Event = {
      type: "node.updated",
      driver: CURSOR_PROVIDER,
      node: {
        id: nodeId,
        threadId: target.threadId,
        runId: target.runId,
        parentNodeId: target.parentNodeId,
        rootNodeId: target.rootNodeId,
        kind: "reasoning",
        status: completed ? "completed" : "running",
        countsForRun: false,
        providerThreadId: target.providerThreadId,
        providerTurnId: target.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: segment.startedAt,
        completedAt: completed ? now : null,
      },
    };
    const itemEvent: ProviderAdapterV2Event = {
      type: "turn_item.updated",
      driver: CURSOR_PROVIDER,
      turnItem: {
        id: turnItemId,
        threadId: target.threadId,
        runId: target.runId,
        nodeId,
        providerThreadId: target.providerThreadId,
        providerTurnId: target.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: segment.ordinal,
        status: completed ? "completed" : "running",
        title: null,
        startedAt: segment.startedAt,
        completedAt: completed ? now : null,
        updatedAt: now,
        type: "reasoning",
        text: segment.text,
        streaming: !completed,
      },
    };
    yield* emitTextSnapshot(target, segment.nativeItemId, completed, [nodeEvent, itemEvent]);
  });

  const emitToolArtifacts = Effect.fnUntraced(function* (input: {
    readonly active: ActiveCursorToolCall;
    readonly completed: boolean;
    readonly unfinishedStatus?: "interrupted" | "failed" | "cancelled";
  }) {
    const { active } = input;
    const toolCall = active.toolCall;
    const now = yield* DateTime.now;
    const failed = input.completed && cursorToolFailed(toolCall);
    const status = !input.completed
      ? "running"
      : (input.unfinishedStatus ?? (failed ? "failed" : "completed"));
    const nodeId = derive.nodeFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: active.callId,
    });
    const turnItemId = derive.turnItemFromProviderItem({
      driver: CURSOR_PROVIDER,
      nativeItemId: active.callId,
    });
    const nativeItemRef = {
      driver: CURSOR_PROVIDER,
      nativeId: active.callId,
      strength: "strong" as const,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: active.target.threadId,
      runId: active.target.runId,
      parentNodeId: active.target.parentNodeId,
      rootNodeId: active.target.rootNodeId,
      kind: "tool_call",
      status,
      countsForRun: false,
      providerThreadId: active.target.providerThreadId,
      providerTurnId: active.target.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: active.startedAt,
      completedAt: input.completed ? now : null,
    };
    const base = {
      id: turnItemId,
      threadId: active.target.threadId,
      runId: active.target.runId,
      nodeId,
      providerThreadId: active.target.providerThreadId,
      providerTurnId: active.target.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: active.ordinal,
      status,
      title: null,
      startedAt: active.startedAt,
      completedAt: input.completed ? now : null,
      updatedAt: now,
    } satisfies Pick<
      OrchestrationV2TurnItem,
      | "id"
      | "threadId"
      | "runId"
      | "nodeId"
      | "providerThreadId"
      | "providerTurnId"
      | "nativeItemRef"
      | "parentItemId"
      | "ordinal"
      | "status"
      | "title"
      | "startedAt"
      | "completedAt"
      | "updatedAt"
    >;
    const outputText =
      cursorToolOutputText(toolCall) ||
      active.streamedOutput.slice(-MAX_CURSOR_STREAMED_OUTPUT_CHARS);
    let turnItem: OrchestrationV2TurnItem;
    switch (toolCall.type) {
      case "shell":
        turnItem = {
          ...base,
          type: "command_execution",
          input: toolCall.args.command,
          ...(outputText.length === 0 ? {} : { output: outputText }),
          ...(toolCall.result?.status === "success"
            ? { exitCode: toolCall.result.value.exitCode }
            : {}),
        };
        break;
      case "write":
      case "delete":
      case "edit":
      case "generateImage":
        turnItem = {
          ...base,
          type: "file_change",
          fileName: cursorToolFileName(toolCall),
          ...(toolCall.type === "edit" &&
          toolCall.result?.status === "success" &&
          toolCall.result.value.linesAdded !== undefined
            ? { additions: toolCall.result.value.linesAdded }
            : {}),
          ...(toolCall.type === "edit" &&
          toolCall.result?.status === "success" &&
          toolCall.result.value.linesRemoved !== undefined
            ? { deletions: toolCall.result.value.linesRemoved }
            : {}),
          ...(toolCall.type === "edit" &&
          toolCall.result?.status === "success" &&
          toolCall.result.value.diffString !== undefined
            ? { diffStr: toolCall.result.value.diffString }
            : toolCall.result?.status === "error" && outputText.trim().length > 0
              ? { diffStr: outputText }
              : {}),
          ...(toolCall.type === "write" ? { newStr: toolCall.args.fileText } : {}),
        };
        break;
      case "read":
        turnItem = {
          ...base,
          title: formatReadToolLabel(toolCall.args.path),
          type: "dynamic_tool",
          toolName: "Read",
          input: toolCall.args,
          ...(cursorToolOutput(toolCall) === undefined
            ? {}
            : { output: cursorToolOutput(toolCall) }),
        };
        break;
      case "glob":
      case "grep":
      case "ls":
      case "readLints":
      case "semSearch": {
        const pattern = cursorToolSearchPattern(toolCall);
        const searchPath =
          toolCall.type === "grep"
            ? toolCall.args.path
            : toolCall.type === "glob"
              ? toolCall.args.targetDirectory
              : toolCall.type === "semSearch"
                ? toolCall.args.targetDirectories?.join(", ")
                : pattern;
        const results =
          toolCall.result?.status === "error" && outputText.trim().length > 0
            ? [{ fileName: searchPath?.trim() || ".", preview: outputText }]
            : cursorToolSearchResults(toolCall, path);
        turnItem = {
          ...base,
          title:
            formatSearchToolLabel({
              input: toolCall.args,
              ...(pattern === undefined ? {} : { pattern }),
            }) ?? null,
          type: "file_search",
          ...(pattern === undefined ? {} : { pattern }),
          ...(results.length === 0 ? {} : { results: [...results] }),
        };
        break;
      }
      default:
        turnItem = {
          ...base,
          type: "dynamic_tool",
          ...(toolCall.type === "mcp"
            ? mcpToolPresentation({
                serverName: toolCall.args.providerIdentifier,
                toolName: toolCall.args.toolName,
              })
            : {}),
          toolName: cursorToolName(toolCall),
          input: toolCall.type === "mcp" ? (toolCall.args.args ?? {}) : toolCall.args,
          ...(cursorToolOutput(toolCall) === undefined
            ? {}
            : { output: cursorToolOutput(toolCall) }),
        };
    }
    yield* emitProviderEvent({
      type: "node.updated",
      driver: CURSOR_PROVIDER,
      node,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: CURSOR_PROVIDER,
      turnItem,
    });
  });

  return { emitAssistant, emitReasoning, emitToolArtifacts };
}
