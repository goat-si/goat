import type { AgentMessage, ToolCall } from "@cursor/sdk";
import type { OrchestrationV2PlanStep } from "@goat/contracts";

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nestedString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = unknownRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

export function cursorTodoSteps(
  toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  const todos =
    toolCall.result?.status === "success" ? toolCall.result.value.todos : toolCall.args.todos;
  return todos
    .filter((todo) => todo.status !== "cancelled" && todo.content.trim().length > 0)
    .map((todo, index) => ({
      id: `todo-${index + 1}`,
      text: todo.content,
      status:
        todo.status === "inProgress"
          ? "running"
          : todo.status === "completed"
            ? "completed"
            : "pending",
    }));
}

export function assistantTextsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<string> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "assistantMessage") {
      const text = nestedString(record, ["message", "text"]);
      return text === undefined || text.length === 0 ? [] : [text];
    }
    const text = nestedString(record, ["assistantMessage", "text"]);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

function nestedToolResult<Value = Record<string, unknown>>(
  rawResult: unknown,
  mapSuccess: (success: Record<string, unknown>) => Value = (success) => success as Value,
):
  | { readonly status: "success"; readonly value: Value }
  | { readonly status: "error"; readonly error: unknown }
  | undefined {
  const result = unknownRecord(rawResult);
  if (result === undefined) {
    return undefined;
  }
  const success = unknownRecord(result.success);
  if (success !== undefined) {
    return {
      status: "success",
      value: mapSuccess(success),
    };
  }
  return {
    status: "error",
    error: result.error ?? result.permissionDenied ?? result,
  };
}

function nestedGrepWorkspaceResults(success: Record<string, unknown>): Record<string, unknown> {
  const workspaces = unknownRecord(success.workspaceResults);
  if (workspaces === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(workspaces).map(([workspace, rawWorkspaceResult]) => {
      const workspaceResult = unknownRecord(rawWorkspaceResult);
      const content = unknownRecord(workspaceResult?.content);
      const rawMatches = Array.isArray(content?.matches) ? content.matches : [];
      const matches = rawMatches.flatMap((rawFileMatch) => {
        const fileMatch = unknownRecord(rawFileMatch);
        const file = typeof fileMatch?.file === "string" ? fileMatch.file : "";
        const lineMatches = Array.isArray(fileMatch?.matches) ? fileMatch.matches : [];
        return lineMatches.flatMap((rawLineMatch) => {
          const lineMatch = unknownRecord(rawLineMatch);
          if (lineMatch === undefined) {
            return [];
          }
          const line = typeof lineMatch.content === "string" ? lineMatch.content : undefined;
          if (file.length === 0 || line === undefined) {
            return [];
          }
          return [
            {
              file,
              line,
              ...(typeof lineMatch.lineNumber === "number"
                ? { lineNumber: lineMatch.lineNumber }
                : {}),
            },
          ];
        });
      });
      return [
        workspace,
        {
          type: "content",
          output: {
            matches,
            totalMatches:
              typeof content?.totalMatchedLines === "number"
                ? content.totalMatchedLines
                : matches.length,
          },
        },
      ];
    }),
  );
}

function nestedArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function nestedLsDirectory(rawNode: unknown): CursorLsDirectoryNode {
  const node = unknownRecord(rawNode);
  return {
    absPath: typeof node?.absPath === "string" ? node.absPath : "",
    childrenDirs: nestedArray(node?.childrenDirs).map(nestedLsDirectory),
    childrenFiles: nestedArray(node?.childrenFiles).flatMap((rawFile) => {
      const name = unknownRecord(rawFile)?.name;
      return typeof name === "string" ? [{ name }] : [];
    }),
    childrenWereProcessed: node?.childrenWereProcessed === true,
    fullSubtreeExtensionCounts: Object.fromEntries(
      Object.entries(unknownRecord(node?.fullSubtreeExtensionCounts) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
    numFiles: typeof node?.numFiles === "number" ? node.numFiles : 0,
  };
}

export function nestedToolCallFromEnvelope(
  envelope: Record<string, unknown>,
): { readonly callId: string; readonly toolCall: ToolCall } | undefined {
  const callId = typeof envelope.toolCallId === "string" ? envelope.toolCallId : undefined;
  const wrapperEntry = Object.entries(envelope).find(([key]) => key.endsWith("ToolCall"));
  if (wrapperEntry === undefined) {
    return undefined;
  }
  const [wrapperName, rawCall] = wrapperEntry;
  const call = unknownRecord(rawCall);
  if (call === undefined) {
    return undefined;
  }
  const args = unknownRecord(call.args) ?? {};
  const fallbackCallId = `nested-${wrapperName}`;
  const nestedCallId = callId ?? fallbackCallId;

  switch (wrapperName) {
    case "readToolCall": {
      const success = unknownRecord(unknownRecord(call.result)?.success);
      const path =
        typeof args.path === "string"
          ? args.path
          : typeof success?.path === "string"
            ? success.path
            : "<unknown path>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "read",
          args: { path },
          result: nestedToolResult(call.result, (value) => ({
            content: typeof value.content === "string" ? value.content : "",
            totalLines: typeof value.totalLines === "number" ? value.totalLines : 0,
            fileSize: typeof value.fileSize === "number" ? value.fileSize : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "globToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "glob",
          args: {
            globPattern: typeof args.globPattern === "string" ? args.globPattern : "**/*",
            ...(typeof args.targetDirectory === "string"
              ? { targetDirectory: args.targetDirectory }
              : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            files: Array.isArray(value.files)
              ? value.files.filter((file): file is string => typeof file === "string")
              : [],
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            clientTruncated: false,
            ripgrepTruncated: false,
          })),
        } as unknown as ToolCall,
      };
    case "grepToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "grep",
          args: {
            pattern: typeof args.pattern === "string" ? args.pattern : "",
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
            ...(typeof args.outputMode === "string" ? { outputMode: args.outputMode } : {}),
            ...(typeof args.caseInsensitive === "boolean"
              ? { caseInsensitive: args.caseInsensitive }
              : {}),
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
            ...(typeof args.multiline === "boolean" ? { multiline: args.multiline } : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            workspaceResults: nestedGrepWorkspaceResults(value),
          })),
        } as unknown as ToolCall,
      };
    case "shellToolCall": {
      const rawResult = unknownRecord(call.result);
      const permissionDenied = unknownRecord(rawResult?.permissionDenied);
      const command =
        typeof args.command === "string"
          ? args.command
          : typeof permissionDenied?.command === "string"
            ? permissionDenied.command
            : "<unknown command>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "shell",
          args: { command },
          result: nestedToolResult(call.result, (value) => ({
            stdout: typeof value.stdout === "string" ? value.stdout : "",
            stderr: typeof value.stderr === "string" ? value.stderr : "",
            exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
            signal: typeof value.signal === "string" ? value.signal : "",
            executionTime: typeof value.executionTime === "number" ? value.executionTime : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "lsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "ls",
          args: { path: typeof args.path === "string" ? args.path : "" },
          result: nestedToolResult(call.result, (value) => ({
            directoryTreeRoot: nestedLsDirectory(value.directoryTreeRoot),
          })),
        } as unknown as ToolCall,
      };
    case "readLintsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "readLints",
          args: {
            paths: nestedArray(args.paths).filter(
              (path): path is string => typeof path === "string",
            ),
          },
          result: nestedToolResult(call.result, (value) => ({
            fileDiagnostics: nestedArray(value.fileDiagnostics).map((rawFile) => {
              const file = unknownRecord(rawFile);
              return {
                path: typeof file?.path === "string" ? file.path : "",
                diagnostics: nestedArray(file?.diagnostics).flatMap((rawDiagnostic) => {
                  const diagnostic = unknownRecord(rawDiagnostic);
                  return diagnostic === undefined
                    ? []
                    : [
                        {
                          ...diagnostic,
                          message: typeof diagnostic.message === "string" ? diagnostic.message : "",
                        },
                      ];
                }),
              };
            }),
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            totalDiagnostics:
              typeof value.totalDiagnostics === "number" ? value.totalDiagnostics : 0,
          })),
        } as unknown as ToolCall,
      };
    case "mcpToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "mcp",
          args,
          result: nestedToolResult(call.result, (value) => ({
            content: nestedArray(value.content).flatMap((rawPart) => {
              const part = unknownRecord(rawPart);
              return part === undefined ? [] : [part];
            }),
            isError: value.isError === true,
          })),
        } as unknown as ToolCall,
      };
    default: {
      const type = wrapperName.slice(0, -"ToolCall".length);
      return {
        callId: nestedCallId,
        toolCall: {
          type,
          args,
          result: nestedToolResult(call.result),
        } as unknown as ToolCall,
      };
    }
  }
}

export function toolCallsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly callId: string; readonly toolCall: ToolCall }> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "toolCall") {
      const message = unknownRecord(record.message);
      return typeof message?.type === "string"
        ? [
            {
              callId: typeof record.callId === "string" ? record.callId : `nested-${message.type}`,
              toolCall: message as ToolCall,
            },
          ]
        : [];
    }
    const envelope = unknownRecord(record?.toolCall);
    const nested = envelope === undefined ? undefined : nestedToolCallFromEnvelope(envelope);
    return nested === undefined ? [] : [nested];
  });
}

export function textFromAgentMessage(message: AgentMessage): string {
  const value = message.message;
  if (typeof value === "string") {
    return value;
  }
  const direct =
    nestedString(value, ["text"]) ??
    nestedString(value, ["message", "text"]) ??
    nestedString(value, ["userMessage", "text"]) ??
    nestedString(value, ["assistantMessage", "text"]);
  if (direct !== undefined) {
    return direct;
  }
  const content = unknownRecord(value)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const text = unknownRecord(part)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}
