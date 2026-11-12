import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  RunId,
} from "@goat/contracts";
import { resolveGoatMcpItemCall } from "@goat/shared/goatMcpToolPresentation";
import {
  classifyToolActivity,
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@goat/shared/toolActivity";
import * as DateTime from "effect/DateTime";

import { contextCompactionLabel, type WorkLogPresentationEntry } from "./presentation.ts";
import { providerErrorPresentation } from "./providerError.ts";
import { extractToolActivityPresentation } from "./toolPresentation.ts";

/** One turn item as a work log row, shared by coding threads and GOAT Bot's activity line. */
export type TurnItemWorkLogEntry = Omit<WorkLogPresentationEntry, "toolLifecycleStatus"> & {
  readonly toolLifecycleStatus: TurnItemLifecycleStatus;
  readonly runId?: RunId | null;
  readonly sourceActivityKind?: string;
};

type TurnItemLifecycleStatus = "inProgress" | "completed" | "idle" | "failed" | "stopped";

/** When a turn item happened, as its row is placed: started, or last updated. */
export function turnItemCreatedAt(row: OrchestrationV2ProjectedTurnItem): string {
  return DateTime.formatIso(row.item.startedAt ?? row.item.updatedAt);
}

function turnItemLifecycleStatus(item: OrchestrationV2TurnItem): TurnItemLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "completed":
      return "completed";
    case "idle":
      return "idle";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function turnItemTone(item: OrchestrationV2TurnItem): TurnItemWorkLogEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
    case "thread_created":
    case "user_input_request":
    case "approval_request":
      return "tool";
    default:
      return "info";
  }
}

export function turnItemWorkLogEntry(row: OrchestrationV2ProjectedTurnItem): TurnItemWorkLogEntry {
  const { item } = row;
  const title = item.title?.trim() || null;
  const common = {
    id: item.id,
    createdAt: turnItemCreatedAt(row),
    runId: item.runId,
    tone: turnItemTone(item),
    itemType: item.type,
    toolLifecycleStatus: turnItemLifecycleStatus(item),
    structuredPayload: item,
    ...extractToolActivityPresentation(item),
  } as const;

  switch (item.type) {
    case "thread_created":
      return {
        ...common,
        label: "Created thread",
      };
    case "compaction":
      return {
        ...common,
        label: contextCompactionLabel(item),
        sourceActivityKind: "context-compaction",
        ...(item.summary ? { detail: item.summary } : {}),
      };
    case "reasoning":
      return {
        ...common,
        label: title ?? "Thinking",
        ...(item.text ? { detail: item.text } : {}),
      };
    case "command_execution":
      return {
        ...common,
        label: title ?? "Ran command",
        command: item.input,
        rawCommand: item.input,
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change": {
      return {
        ...common,
        label:
          title ??
          (item.changes !== undefined && item.changes.length > 1
            ? `Changed ${item.changes.length} files`
            : `Changed ${item.fileName}`),
        changedFiles: item.changes?.map((change) => change.path) ?? [item.fileName],
        toolTitle: title ?? "File change",
        toolData: item,
      };
    }
    case "file_search":
      return {
        ...common,
        label: title ?? formatSearchToolLabel(item) ?? "Searched files",
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        ...common,
        label: title ?? "Searched the web",
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "checkpoint":
      return {
        ...common,
        label: title ?? "Checkpoint captured",
        changedFiles: item.files.map((file) => file.path),
        toolData: item,
      };
    case "system_notice": {
      // The first line is the row; the rest opens with it, so a long notice stays one line.
      const [headline = "", ...rest] = item.message.split("\n");
      const detail = rest.join("\n").trim();
      return {
        ...common,
        label: headline,
        ...(detail.length > 0 ? { detail } : {}),
        ...(item.severity === "info" ? {} : { sourceActivityKind: "runtime.warning" }),
      };
    }
    case "error": {
      const presentation = providerErrorPresentation(item);
      return {
        ...common,
        ...presentation,
        ...(item.failure.class === "usage_limit" && item.status !== "completed"
          ? { sourceActivityKind: "runtime.warning" }
          : item.retry === undefined
            ? { sourceActivityKind: "runtime.error" }
            : {}),
        toolData: item,
      };
    }
    case "dynamic_tool": {
      const call = resolveGoatMcpItemCall(item);
      const classified = classifyToolActivity({ itemType: "dynamic_tool_call", data: call });
      return {
        ...common,
        label:
          title ??
          (classified === "read"
            ? formatReadToolLabel(collectToolFilePaths({ input: call.input })[0] ?? "")
            : classified === "search"
              ? (formatSearchToolLabel({ input: call.input }) ?? call.toolName ?? "Tool call")
              : (call.toolName ?? "Tool call")),
        toolTitle: title ?? call.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    }
    case "approval_request":
      return {
        ...common,
        label: title ?? "Approval requested",
        detail: item.prompt ?? item.requestKind,
        toolData: item,
      };
    case "user_input_request":
      return {
        ...common,
        label: title ?? (item.questionAnswer ? "Answered questions" : "Input requested"),
        ...(item.questionAnswer ? { questionAnswer: item.questionAnswer } : {}),
        toolData: item,
      };
    default:
      return {
        ...common,
        label: title ?? item.type.replaceAll("_", " "),
        toolData: item,
      };
  }
}
