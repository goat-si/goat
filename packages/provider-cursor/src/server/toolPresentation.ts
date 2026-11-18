import type { ToolCall } from "@cursor/sdk";
import type * as Path from "effect/Path";
import { cursorToolOutput } from "./toolOutput.ts";

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

export function cursorToolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === "error") {
    return true;
  }
  return toolCall.type === "mcp" && toolCall.result?.status === "success"
    ? toolCall.result.value.isError
    : false;
}

export function cursorToolOutputText(toolCall: ToolCall): string {
  if (toolCall.type === "shell" && toolCall.result?.status === "success") {
    return [toolCall.result.value.stdout, toolCall.result.value.stderr]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (toolCall.type === "mcp" && toolCall.result?.status === "success") {
    return toolCall.result.value.content
      .flatMap((part) => (part.text === undefined ? [] : [part.text.text]))
      .join("\n");
  }
  const output = cursorToolOutput(toolCall);
  if (output === undefined) {
    return "";
  }
  return typeof output === "string" ? output : stableJson(output);
}

export function cursorToolName(toolCall: ToolCall): string {
  if (toolCall.type !== "mcp") {
    return toolCall.type;
  }
  const provider = toolCall.args.providerIdentifier ?? "mcp";
  const tool = toolCall.args.toolName ?? "unknown";
  return `mcp__${provider}__${tool}`;
}

export function cursorToolFileName(toolCall: ToolCall): string {
  switch (toolCall.type) {
    case "write":
    case "delete":
    case "read":
    case "edit":
    case "ls":
      return toolCall.args.path;
    case "generateImage":
      return toolCall.args.filePath ?? "generated-image";
    default:
      return cursorToolName(toolCall);
  }
}

export function cursorToolSearchPattern(toolCall: ToolCall): string | undefined {
  switch (toolCall.type) {
    case "glob":
      return toolCall.args.globPattern;
    case "grep":
      return toolCall.args.pattern;
    case "semSearch":
      return toolCall.args.query;
    case "ls":
      return toolCall.args.path;
    case "readLints":
      return toolCall.args.paths.join(", ");
    default:
      return undefined;
  }
}

function cursorLsSearchResults(
  node: CursorLsDirectoryNode,
  path: Path.Path,
): ReadonlyArray<{ readonly fileName: string }> {
  return [
    ...node.childrenFiles.map((file) => ({ fileName: path.join(node.absPath, file.name) })),
    ...node.childrenDirs.flatMap((child) => cursorLsSearchResults(child, path)),
  ];
}

export function cursorToolSearchResults(
  toolCall: ToolCall,
  path: Path.Path,
): ReadonlyArray<{
  readonly fileName: string;
  readonly line?: number;
  readonly column?: number;
  readonly preview?: string;
}> {
  if (toolCall.result?.status !== "success") {
    return [];
  }
  switch (toolCall.type) {
    case "glob":
      return toolCall.result.value.files.map((fileName) => ({ fileName }));
    case "grep":
      return Object.values(toolCall.result.value.workspaceResults ?? {}).flatMap((result) => {
        if (result.type === "files") {
          return result.output.files.map((fileName) => ({ fileName }));
        }
        if (result.type === "count") {
          return result.output.counts.map((entry) => ({
            fileName: entry.file,
            preview: `${entry.count} ${entry.count === 1 ? "match" : "matches"}`,
          }));
        }
        return result.output.matches.map((entry) => ({
          fileName: entry.file,
          ...(entry.lineNumber === undefined ? {} : { line: entry.lineNumber }),
          preview: entry.line,
        }));
      });
    case "ls":
      return cursorLsSearchResults(toolCall.result.value.directoryTreeRoot, path);
    case "readLints":
      return toolCall.result.value.fileDiagnostics.flatMap((file) =>
        file.diagnostics.map((diagnostic) => {
          const line = diagnostic.range?.start?.line;
          const character = diagnostic.range?.start?.character;
          const hasLine = typeof line === "number" && Number.isInteger(line) && line >= 0;
          return {
            fileName: file.path,
            ...(hasLine ? { line: line + 1 } : {}),
            ...(hasLine &&
            typeof character === "number" &&
            Number.isInteger(character) &&
            character >= 0
              ? { column: character + 1 }
              : {}),
            preview: diagnostic.message,
          };
        }),
      );
    case "semSearch":
      return [
        {
          fileName: "semantic-search",
          preview: toolCall.result.value.results,
        },
      ];
    default:
      return [];
  }
}
