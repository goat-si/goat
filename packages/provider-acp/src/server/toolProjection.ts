import type { OrchestrationV2WebSearchResult } from "@goat/contracts";
import { textFromUnknown } from "./toolOutputText.ts";
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

export function resolvedPathInfo(
  toolCall: AcpToolCallState,
): { readonly path: string; readonly fromQuery: boolean } | undefined {
  const locations = toolCall.data.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = unknownRecord(location)?.path;
      if (typeof path === "string" && path.trim().length > 0) {
        return { path: path.trim(), fromQuery: false };
      }
    }
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  for (const key of ["path", "filePath", "file_path", "url"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return { path: candidate.trim(), fromQuery: false };
    }
  }
  for (const key of ["query", "pattern"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return { path: candidate.trim(), fromQuery: true };
    }
  }
  return undefined;
}

export function pathFromToolCall(toolCall: AcpToolCallState): string | undefined {
  return resolvedPathInfo(toolCall)?.path;
}

export function acpBackendWebSearch(
  rawInput: Record<string, unknown> | undefined,
  rawOutput: unknown,
  title?: string | null,
):
  | { readonly query: string | undefined; readonly results: OrchestrationV2WebSearchResult[] }
  | undefined {
  const variant = typeof rawInput?.variant === "string" ? rawInput.variant.toLowerCase() : "";
  const rawOutputRecord = unknownRecord(rawOutput);
  const action = unknownRecord(rawOutputRecord?.action);
  const isWebSearchTitle =
    /^\s*(?:web search|search the web|(?:run(?:ning)?\s+)?(?:web_search|search_web)\s*$)/iu.test(
      title ?? "",
    );
  const isWebSearchVariant = [
    "xsearch",
    "websearch",
    "web_search",
    "search_web",
    "web-search",
  ].includes(variant);
  if (!isWebSearchVariant && action?.type !== "search" && !isWebSearchTitle) {
    return undefined;
  }
  let args: Record<string, unknown> | undefined;
  if (typeof rawOutputRecord?.input === "string") {
    try {
      args = unknownRecord(JSON.parse(rawOutputRecord.input));
    } catch {
      args = undefined;
    }
  }
  const argsText = Object.entries(args ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const query = [
    action?.query,
    args?.query,
    rawInput?.query,
    rawInput?.search_query,
    rawInput?.q,
    argsText,
  ]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const urls = new Set<string>();
  for (const source of Array.isArray(action?.sources) ? action.sources : []) {
    const url = unknownRecord(source)?.url;
    if (typeof url === "string" && url.trim().length > 0) urls.add(url.trim());
  }
  if (urls.size === 0) {
    for (const match of textFromUnknown(rawOutput)?.matchAll(/https?:\/\/[^\s<>"]+/gu) ?? []) {
      urls.add(trimCitationUrl(match[0]));
    }
  }
  return { query, results: [...urls].map((url) => ({ url })) };
}

// Prose citations end in punctuation or a closing bracket that is not part of the URL.
function trimCitationUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(/[.,;:]+$/u, "");
    const close = trimmed.at(-1);
    const open = close === ")" ? "(" : close === "]" ? "[" : undefined;
    if (open && close && trimmed.split(open).length < trimmed.split(close).length) {
      url = trimmed.slice(0, -1);
    } else if (trimmed === url) {
      return url;
    } else {
      url = trimmed;
    }
  }
}

export function webSearchLabel(title: string): string {
  return title
    .replace(/:\s*$/u, "")
    .replace(/^\s*(?:run(?:ning)?\s+)?(?:web_search|search_web)\s*$/iu, "Web search");
}
