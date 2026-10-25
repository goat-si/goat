import { LEGACY_MCP_APP_OUTPUT_KEY } from "@goat/contracts/legacyT3Names";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@goat/contracts";
import * as Predicate from "effect/Predicate";

import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./htmlRender.ts";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference, type McpAppReference } from "./mcpApp.ts";
import { resolveGoatMcpItemCall, resolveGoatMcpShippedToolId } from "./goatMcpToolPresentation.ts";

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

interface ResultReadBudget {
  remainingBytes: number;
  remainingNodes: number;
  exceeded: boolean;
}

interface ResultEnvelope {
  data?: Record<PropertyKey, unknown>;
  failed: boolean;
}

interface CompactToolOutput {
  isError?: true;
  threadId?: string;
  messageId?: string;
  taskId?: string;
  scheduledTaskId?: string;
  status?: "rolled_back";
  htmlRender?: HtmlRenderReference;
  [MCP_APP_OUTPUT_KEY]?: McpAppReference;
  thread?: { threadId: string };
  threads?: Array<{ threadId?: string; status?: "rolled_back" }>;
  settle?: ToolOutputSettle;
}

export interface ToolOutputSettle {
  readonly outcome: string;
  readonly reason: string;
}

const SETTLE_PREFIX = "Notification settle: ";
// A reason can name an AX notification, such as notification_unsupported:AXMoved.
const SETTLE_SUMMARY = /^Notification settle: ([a-z_]{1,32}) \(([A-Za-z0-9_:]{0,128})\)/;
const MAX_SETTLE_TEXTS = 32;

function settleRecord(value: unknown, depth = 0): ToolOutputSettle | undefined {
  if (!Predicate.isObject(value) || depth > MAX_ENVELOPE_DEPTH) return undefined;
  const settle = value.settle;
  if (
    Predicate.isObject(settle) &&
    typeof settle.outcome === "string" &&
    settle.outcome.length <= 32
  )
    return {
      outcome: settle.outcome,
      reason: typeof settle.reason === "string" ? settle.reason.slice(0, 128) : "",
    };
  for (const key of ["structuredContent", "result", "value"] as const) {
    const nested = settleRecord(value[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Text a provider kept from a tool result: a plain string, MCP and Cursor parts, ACP wrappers. */
function resultTexts(value: unknown, texts: string[], depth = 0): void {
  if (depth > MAX_ENVELOPE_DEPTH || texts.length >= MAX_SETTLE_TEXTS) return;
  if (typeof value === "string") {
    texts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, MAX_CONTENT_BLOCKS)) resultTexts(entry, texts, depth + 1);
    return;
  }
  if (!Predicate.isObject(value)) return;
  const text = Predicate.isObject(value.text) ? value.text.text : value.text;
  if (typeof text === "string") resultTexts(text, texts, depth + 1);
  for (const key of ["content", "result", "value"] as const)
    if (value[key] !== undefined) resultTexts(value[key], texts, depth + 1);
}

/**
 * The outcome of a computer-use settle wait (#1506), which completes as a tool call whether or
 * not the window settled. Providers keep its structured fields, fold them into a JSON text block,
 * or keep only the helper's own "Notification settle: <outcome> (<reason>)" line.
 */
export function toolOutputSettle(value: unknown): ToolOutputSettle | undefined {
  const direct = settleRecord(value);
  if (direct !== undefined) return direct;
  const texts: string[] = [];
  resultTexts(value, texts);
  for (const text of texts) {
    // A provider may join the summary after a folded sample far larger than the parse budget, so
    // the line is found by search, and only small text is parsed as JSON.
    for (let at = text.indexOf(SETTLE_PREFIX); at >= 0; at = text.indexOf(SETTLE_PREFIX, at + 1)) {
      // The same words inside a sample (a window title) are not the helper's line.
      if (at > 0 && text[at - 1] !== "\n") continue;
      const summary = SETTLE_SUMMARY.exec(text.slice(at, at + 256));
      if (summary?.[1] !== undefined) return { outcome: summary[1], reason: summary[2] ?? "" };
    }
    if (text.length > MAX_PARSED_BYTES || !text.trimStart().startsWith("{")) continue;
    try {
      const folded = settleRecord(JSON.parse(text));
      if (folded !== undefined) return folded;
    } catch {
      // Plain text that only looks like JSON.
    }
  }
  return undefined;
}

const ENVELOPE_KEYS: ReadonlySet<PropertyKey> = new Set(["status", "value", "meta"]);

function isOkEnvelope(
  value: Record<PropertyKey, unknown>,
): value is { readonly status: "ok"; readonly value: unknown } {
  return (
    value.status === "ok" &&
    "value" in value &&
    Object.keys(value).every((key) => ENVELOPE_KEYS.has(key))
  );
}

function readResult(value: unknown, budget: ResultReadBudget, depth = 0): ResultEnvelope {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data: ResultEnvelope["data"];
    let failed = false;
    for (const block of value) {
      const text = Predicate.isObject(block) ? block.text : undefined;
      const result = readResult(
        Predicate.isObject(text) ? (text.text ?? text) : text,
        budget,
        depth + 1,
      );
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!Predicate.isObject(value)) return { failed: false };
  // goat_call's envelope, which `goat call` and `goat acp-mcp-call` print: an ok result is its value.
  if (isOkEnvelope(value)) return readResult(value.value, budget, depth + 1);
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const content = value.structuredContent ?? value.content;
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

export function compactDynamicToolOutput(value: unknown): CompactToolOutput | undefined {
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output: CompactToolOutput = result.failed ? { isError: true } : {};
  const settle = toolOutputSettle(value);
  if (settle !== undefined) output.settle = settle;
  const data = budget.exceeded ? undefined : result.data;
  if (data !== undefined) {
    for (const key of ["threadId", "messageId", "taskId", "scheduledTaskId"] as const) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const mcpApp =
      readMcpAppReference(data[MCP_APP_OUTPUT_KEY]) ??
      readMcpAppReference(data[LEGACY_MCP_APP_OUTPUT_KEY]);
    // Compact wire output retains the legacy key for older clients.
    if (mcpApp !== undefined) output[MCP_APP_OUTPUT_KEY] = mcpApp;
    const nestedThreadId = Predicate.isObject(data.thread)
      ? boundedId(data.thread.threadId)
      : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads: NonNullable<CompactToolOutput["threads"]> = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!Predicate.isObject(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" as const } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // A partial batch or a top-level ID would turn an unknown creation
        // count into a confidently wrong one in the existing summary parser.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  const oversized = () => encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES;
  if (oversized()) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
  }
  const app = output[MCP_APP_OUTPUT_KEY];
  if (app?.csp !== undefined && oversized()) {
    const { csp: _csp, ...rest } = app;
    output[MCP_APP_OUTPUT_KEY] = rest;
  }
  if (oversized()) delete output[MCP_APP_OUTPUT_KEY];
  return Object.keys(output).length === 0 ? undefined : output;
}

export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  const { toolName } = resolveGoatMcpItemCall(item);
  if (resolveGoatMcpShippedToolId(toolName) !== HTML_RENDER_TOOL_NAME) return undefined;
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/**
 * The MCP App a completed tool call carries, if any. The adapter that captured
 * it put the reference in the output, beside the tool's own result. A tool's
 * result can imitate that shape, so the reference only counts when it names
 * the very server and tool the item records: a server can then only ever
 * point at an app of its own.
 */
export function mcpAppFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): McpAppReference | undefined {
  const app = compactDynamicToolOutput(item.output)?.[MCP_APP_OUTPUT_KEY];
  return app !== undefined && item.toolName === `${app.server}.${app.tool}` ? app : undefined;
}

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    /file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
    (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
    (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/**
 * Only raster types are recognized, so the server never serves an agent's SVG
 * or HTML inline.
 */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

export const MAX_TOOL_OUTPUT_IMAGES = 8;

export const MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH =
  Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4;

export function toolOutputImageBlocks(value: unknown): ReadonlyArray<unknown> {
  const blocks: unknown[] = [];
  for (const block of outputBlocks(value)) {
    if (readToolOutputImage(block) === null) continue;
    blocks.push(block);
    if (blocks.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return blocks;
}

/**
 * The order is the `tool-output-image` asset index, so servers and clients
 * agree on it.
 */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  return toolOutputImageBlocks(value).flatMap((block) => readToolOutputImage(block) ?? []);
}

/**
 * Readers prefer an MCP result's structured output, but an image such as a computer-use
 * screenshot travels only in `content`, so that content stays beside it.
 */
export function mcpToolResultOutput(result: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): unknown {
  const { content, structuredContent } = result;
  if (structuredContent === undefined || structuredContent === null) {
    return content ?? undefined;
  }
  return toolOutputImageBlocks(content).length === 0
    ? structuredContent
    : { content, structuredContent };
}

const BASE64_IMAGE_DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * A harness that reports an MCP result as its text and structured output, as Claude does,
 * leaves the images in the raw tool result, so those blocks come back beside that output.
 */
export function mcpToolResultWithRawImages(output: unknown, rawContent: unknown): unknown {
  if (toolOutputImageBlocks(output).length > 0 || toolOutputImageBlocks(rawContent).length === 0) {
    return output;
  }
  const structuredContent =
    Predicate.isObject(output) && output.structuredContent != null
      ? output.structuredContent
      : output;
  return { content: rawContent, structuredContent };
}

/** An image a provider sent as a base64 data URL, as the image block the parser reads. */
export function imageBlockFromDataUrl(
  url: string,
): { readonly type: "image"; readonly mimeType: string; readonly data: string } | undefined {
  const [, mimeType, data] = BASE64_IMAGE_DATA_URL.exec(url) ?? [];
  if (mimeType === undefined || data === undefined) return undefined;
  const block = { type: "image" as const, mimeType, data };
  return readToolOutputImage(block) === null ? undefined : block;
}

export function omitToolOutputImageData(value: unknown): unknown {
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
