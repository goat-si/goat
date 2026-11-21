import type { OrchestrationV2WebSearchResult } from "@goat/contracts";
import type { AcpToolCallState } from "./runtimeModel.ts";
import { unknownRecord } from "./clientPolicy.ts";
import { mcpToolResultOutput } from "@goat/shared/toolOutput";

export function acpMcpToolCallOutput(rawOutput: unknown): unknown {
  const record = unknownRecord(rawOutput);
  if (record === undefined) return rawOutput;
  if (!("result" in record) && !("error" in record)) return rawOutput;
  const result = unknownRecord(record.result);
  const resultOutput = result === undefined ? undefined : mcpToolResultOutput(result);
  const errorMessage = unknownRecord(record.error)?.message;
  if (typeof errorMessage !== "string") {
    return resultOutput ?? rawOutput;
  }
  return resultOutput === undefined
    ? { error: errorMessage }
    : { error: errorMessage, result: resultOutput };
}

export function commandExitCode(value: unknown): number | undefined {
  const record = unknownRecord(value);
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = record?.[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Mid-stream Grok Bash re-reports carry exit_code 0 while still in progress;
 * interrupted tools must not retain that stale success code.
 */
export function acpProjectedCommandExitCode(
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted",
  rawOutput: unknown,
): number | undefined {
  if (status !== "completed" && status !== "failed") {
    return undefined;
  }
  return commandExitCode(rawOutput);
}

export function pathFromToolCall(toolCall: AcpToolCallState): string | undefined {
  const locations = toolCall.data.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = unknownRecord(location)?.path;
      if (typeof path === "string" && path.trim().length > 0) {
        return path.trim();
      }
    }
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  for (const key of ["path", "filePath", "file_path", "url", "query", "pattern"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function acpBackendWebSearch(
  rawInput: Record<string, unknown> | undefined,
  rawOutput: Record<string, unknown> | undefined,
):
  | { readonly query: string | undefined; readonly results: OrchestrationV2WebSearchResult[] }
  | undefined {
  const variant = typeof rawInput?.variant === "string" ? rawInput.variant.toLowerCase() : "";
  const action = unknownRecord(rawOutput?.action);
  if (variant !== "xsearch" && variant !== "websearch" && action?.type !== "search") {
    return undefined;
  }
  let args: Record<string, unknown> | undefined;
  if (typeof rawOutput?.input === "string") {
    try {
      args = unknownRecord(JSON.parse(rawOutput.input));
    } catch {
      args = undefined;
    }
  }
  const argsText = Object.entries(args ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const query = [action?.query, args?.query, argsText]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const urls = new Set<string>();
  for (const source of Array.isArray(action?.sources) ? action.sources : []) {
    const url = unknownRecord(source)?.url;
    if (typeof url === "string" && url.trim().length > 0) urls.add(url.trim());
  }
  return { query, results: [...urls].map((url) => ({ url })) };
}
