import {
  CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
  CHANNEL_BOT_ARTIFACT_MAX_BYTES,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
  type ChannelTaskStatus,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

import { goatBotDayLabel, goatBotLocalDate } from "./labels.ts";

export type BotArtifactRead =
  | {
      readonly status: "ok";
      readonly mimeType: string;
      readonly size: number;
      readonly bytes: Uint8Array<ArrayBuffer>;
    }
  | { readonly status: "too_large"; readonly size: number; readonly maxBytes: number }
  | { readonly status: "busy" }
  | { readonly status: "changed" }
  | { readonly status: "invalid" };

const MAX_CHUNK_BASE64 = 4 * Math.ceil(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES / 3);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Attempt = BotArtifactRead | { readonly status: "restart" };

async function readOnce(
  relativePath: string,
  readChunk: (input: ChannelReadBotArtifactInput) => Promise<ChannelReadBotArtifactResult>,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  let buffer: Uint8Array<ArrayBuffer> | null = null;
  let version = "";
  let filled = 0;
  for (;;) {
    if (signal?.aborted) return { status: "changed" };
    const answer = await readChunk(
      filled === 0 && buffer === null
        ? { relativePath }
        : { relativePath, offset: filled, version },
    );
    if (answer.status === "too_large")
      return { status: "too_large", size: answer.size, maxBytes: answer.maxBytes };
    if (answer.status === "busy") return { status: "busy" };
    if (answer.status === "changed") return { status: "restart" };
    if (buffer === null) {
      if (answer.offset !== 0 || answer.size > CHANNEL_BOT_ARTIFACT_MAX_BYTES)
        return { status: "invalid" };
      buffer = new Uint8Array(answer.size);
      version = answer.version;
    } else if (
      answer.version !== version ||
      answer.offset !== filled ||
      answer.size !== buffer.length
    ) {
      return { status: "restart" };
    }
    const encoded = answer.bytesBase64;
    if (encoded.length > MAX_CHUNK_BASE64 || encoded.length % 4 !== 0 || !BASE64.test(encoded))
      return { status: "invalid" };
    const decoded = Base64.decode(encoded);
    if (Result.isFailure(decoded)) return { status: "invalid" };
    const bytes = decoded.success;
    const end = filled + bytes.length;
    if (bytes.length > CHANNEL_BOT_ARTIFACT_CHUNK_BYTES || end > buffer.length)
      return { status: "invalid" };
    if (answer.done !== (end === buffer.length)) return { status: "invalid" };
    if (!answer.done && bytes.length === 0) return { status: "invalid" };
    buffer.set(bytes, filled);
    filled = end;
    if (answer.done)
      return { status: "ok", mimeType: answer.mimeType, size: buffer.length, bytes: buffer };
  }
}

/**
 * Reads a Library file one chunk at a time, as the contract asks: every later chunk names the
 * first chunk's version. A file that changes during the read is read again once.
 */
export async function readWholeBotArtifact(
  relativePath: string,
  readChunk: (input: ChannelReadBotArtifactInput) => Promise<ChannelReadBotArtifactResult>,
  signal?: AbortSignal,
): Promise<BotArtifactRead> {
  const first = await readOnce(relativePath, readChunk, signal);
  if (first.status !== "restart") return first;
  const second = await readOnce(relativePath, readChunk, signal);
  return second.status === "restart" ? { status: "changed" } : second;
}

export const botArtifactName = (relativePath: string) =>
  relativePath.split("/").at(-1) ?? relativePath;

const INLINE_CODE = /`([^`\n]+)`/g;

// Fences CommonMark is certain of without tracking containers: 3+ backticks (none in the info
// string) or tildes, unindented, or indented up to 3 spaces before any list item or quote. After
// an indented fence that follows one, or a line that may open an HTML block, the rest of the reply
// is read as it is: such a fence may close with its container, and a marker in HTML is HTML.
const FENCE_OPEN = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CONTAINER_START = /^ {0,3}(?:>|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const HTML_START = /^ {0,3}</;

/** The reply without the lines of its top-level fenced code blocks; an unclosed one runs to the end. */
function outsideFences(text: string): string {
  const kept: Array<string> = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let containerSeen = false;
  const lines = text.split(/\r?\n/);
  // The rest of the reply from `index` on, as it is; joined, never spread, so a long reply is fine.
  const readAsIs = (index: number) => [...kept, lines.slice(index).join("\n")].join("\n");
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close !== undefined && close[0] === fence.char && close.length >= fence.length)
        fence = null;
      kept.push("");
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    const open = opening?.[2];
    if (HTML_START.test(line) || (open !== undefined && opening?.[1] !== "" && containerSeen))
      return readAsIs(index);
    if (open === undefined) {
      if (CONTAINER_START.test(line)) containerSeen = true;
      kept.push(line);
    } else {
      fence = { char: open[0] ?? "`", length: open.length };
      kept.push("");
    }
  }
  return kept.join("\n");
}

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
// The names the server lists (plainName in ChannelBotArtifacts): no leading dot, colon, backslash or edge spaces.
const listableName = (name: string) =>
  name !== "" && !name.startsWith(".") && !/[:\\]/.test(name) && name === name.trim();

/**
 * `path` with `.` and repeated separators removed, or null when it is not absolute or has a `..`
 * segment: a link inside the folder can make `..` lead elsewhere, so it is never resolved here.
 */
function normalizedAbsolute(path: string, windows: boolean): string | null {
  if (windows ? !WINDOWS_ABSOLUTE.test(path) : !path.startsWith("/")) return null;
  const parts = path.split(windows ? /[\\/]/ : "/");
  // A drive ("C:") stays first; a UNC path keeps a "//" start so it never equals a drive path.
  const head = !windows
    ? []
    : /^[A-Za-z]:$/.test(parts[0] ?? "")
      ? [parts.shift() ?? ""]
      : ["", ""];
  const kept: Array<string> = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    kept.push(part);
  }
  const joined = [...head, ...kept].join("/");
  // Windows compares paths without regard to case; elsewhere a different case is a different file.
  return windows ? joined.toLowerCase() : joined;
}

/**
 * Library files a reply names in inline code, in order, each once.
 * Rule: a relative path names a file only when it is exactly the listed path; an absolute path
 * only when, normalized, it is `root` + "/" + the listed path; without `root` (an older server),
 * absolute paths name nothing, and a caller that passes none gets that rule too.
 */
export function goatBotReplyFiles<File extends { readonly relativePath: string }>(
  text: string,
  files: ReadonlyArray<File>,
  root?: string,
): ReadonlyArray<File> {
  const windows = root !== undefined && (root.includes("\\") || /^[A-Za-z]:/.test(root));
  const folder = root === undefined ? null : normalizedAbsolute(root, windows);
  const named: Array<File> = [];
  for (const match of outsideFences(text).matchAll(INLINE_CODE)) {
    const code = (match[1] ?? "").trim();
    const absolute = folder === null ? null : normalizedAbsolute(code, windows);
    const file = files.find((candidate) =>
      absolute === null
        ? code === candidate.relativePath
        : absolute ===
          (windows
            ? `${folder}/${candidate.relativePath.toLowerCase()}`
            : `${folder}/${candidate.relativePath}`),
    );
    if (file !== undefined && !named.includes(file)) named.push(file);
  }
  return named;
}

/**
 * True when a reply has inline code that could name a file the Library can list, so it is worth
 * reading: a relative path of listable names, or an absolute path ending in one.
 */
export function goatBotReplyMayNameFile(text: string): boolean {
  for (const match of outsideFences(text).matchAll(INLINE_CODE)) {
    const code = (match[1] ?? "").trim();
    if (code.startsWith("/") || WINDOWS_ABSOLUTE.test(code)) {
      if (listableName(code.split(/[\\/]/).at(-1) ?? "")) return true;
    } else if (code.length <= 512 && code.split("/").every(listableName)) return true;
  }
  return false;
}

const TEXT_TYPES = new Set(["application/json", "text/csv"]);
/** Text and code files by name, for a card that names a file's kind before or without reading it. */
const TEXT_NAMES =
  /\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|vue|svelte|lua|diff|patch)$/i;
/** Larger text stays a download: decoding and rendering it would stall the chat. */
export const BOT_ARTIFACT_MAX_SHOWN_TEXT_BYTES = 1024 * 1024;

/** How the Library shows a file: rendered markdown, plain text, an image, or a download. */
export function botArtifactViewKind(
  mimeType: string,
  relativePath: string,
  size = 0,
): "markdown" | "text" | "image" | "download" {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (size > BOT_ARTIFACT_MAX_SHOWN_TEXT_BYTES) return "download";
  if (type === "text/markdown" || /\.(md|markdown)$/i.test(relativePath)) return "markdown";
  if (type.startsWith("text/") || TEXT_TYPES.has(type)) return "text";
  // Named alone: the file's own type decides once it is read.
  if (type === "" && TEXT_NAMES.test(relativePath)) return "text";
  return "download";
}

/**
 * Newest-first Library files under one heading per local calendar day, order kept. `key` is that
 * day as YYYY-MM-DD and unique; a date from another year shows its year in the label.
 */
export function goatBotArtifactDays<File extends { readonly modifiedAt: string }>(
  files: ReadonlyArray<File>,
  nowMs: number,
): ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly files: ReadonlyArray<File>;
}> {
  const days = new Map<string, { key: string; label: string; files: File[] }>();
  for (const file of files) {
    const key = goatBotLocalDate(file.modifiedAt);
    const day = days.get(key);
    if (day !== undefined) day.files.push(file);
    else
      days.set(key, {
        key,
        label: goatBotDayLabel(file.modifiedAt, nowMs, { yearWhenOther: true }),
        files: [file],
      });
  }
  return [...days.values()];
}

export function botArtifactSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What to say when a file did not open. */
export function botArtifactOpenMessage(
  name: string,
  result: Exclude<BotArtifactRead, { status: "ok" }>,
  botName = "GOAT Bot",
): string {
  switch (result.status) {
    case "too_large":
      return `${name} is larger than 20 MB, so ${botName} can't send it here.`;
    case "busy":
      // Both clients: the server answered busy or a chunk ran past its bound.
      return `${name} is taking too long to open. Try again in a moment.`;
    case "changed":
      return `${name} changed while it was opening. Try again.`;
    case "invalid":
      return `Couldn't open ${name}. Try again.`;
  }
}

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;

/** Why the Library cannot load, and whether trying again can help. */
export function botArtifactsFailure(
  error: unknown,
  botName = "GOAT Bot",
): { message: string; retry: boolean } {
  if (tagOf(error) === "EnvironmentAuthorizationError")
    return { message: `This device can't read ${botName}'s files.`, retry: false };
  if (
    tagOf(error) === "ChannelGatewayError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "not_home"
  )
    return { message: `${botName}'s files are on its home computer.`, retry: false };
  return { message: `Couldn't load ${botName}'s files.`, retry: true };
}

export const BOT_RUNNING_TASK_STATUSES = [
  "received",
  "dispatching",
  "running",
  "waiting_input",
] as const satisfies ReadonlyArray<ChannelTaskStatus>;

interface BotComputerTask {
  readonly taskId: string;
  readonly title: string;
  readonly status: ChannelTaskStatus;
  readonly updatedAt: string;
  readonly host?: string | undefined;
  readonly worker?: { readonly host?: string | undefined } | undefined;
}

export interface BotComputer<Task extends BotComputerTask = BotComputerTask> {
  /** Null for GOAT Bot's own machine. */
  readonly host: string | null;
  readonly tasks: ReadonlyArray<Task>;
}

/**
 * The machines GOAT Bot's running work uses. A task with a worker is where its worker is (no host
 * means GOAT Bot's own machine); a task still waiting for one is where it was asked to run.
 */
export function botComputers<Task extends BotComputerTask>(
  tasks: ReadonlyArray<Task>,
): ReadonlyArray<BotComputer<Task>> {
  const running = new Set<string>(BOT_RUNNING_TASK_STATUSES);
  const groups = new Map<string | null, Task[]>();
  for (const task of tasks) {
    if (!running.has(task.status)) continue;
    const host = (task.worker === undefined ? task.host : task.worker.host) ?? null;
    groups.set(host, [...(groups.get(host) ?? []), task]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([host, items]) => ({
      host,
      tasks: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
}

const PREVIEW_TEXT_CHARS = 1200;

/**
 * The preview a reply's file card makes room for before the file is read, judged by its name
 * and size, so the card keeps its height when the preview arrives.
 */
export function botArtifactPreviewSlot(
  relativePath: string,
  size: number,
): "image" | "text" | null {
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(relativePath))
    return size <= CHANNEL_BOT_ARTIFACT_CHUNK_BYTES ? "image" : null;
  if (/\.(md|markdown|txt|csv|json|log)$/i.test(relativePath)) return "text";
  return null;
}

/**
 * Whether a reply's file card reads the file's first chunk: only to draw the preview it has room
 * for. Any other card is named from the file's name and costs no read.
 */
export function botArtifactCardReadsFirstChunk(relativePath: string, size: number): boolean {
  return botArtifactPreviewSlot(relativePath, size) !== null;
}

/**
 * What a reply's file card previews from the file's first chunk: the start of a text or
 * markdown file, or an image that fits in that chunk. Anything else shows no preview.
 */
export function botArtifactPreview(
  answer: ChannelReadBotArtifactResult,
):
  | { readonly kind: "markdown" | "text"; readonly text: string }
  | { readonly kind: "image"; readonly bytes: Uint8Array<ArrayBuffer>; readonly mimeType: string }
  | null {
  if (answer.status !== "chunk" || answer.offset !== 0) return null;
  const kind = botArtifactViewKind(answer.mimeType, answer.relativePath, answer.size);
  if (kind === "download" || (kind === "image" && !answer.done)) return null;
  const decoded = Base64.decode(answer.bytesBase64);
  if (Result.isFailure(decoded)) return null;
  const bytes = new Uint8Array(decoded.success);
  if (kind === "image") return { kind, bytes, mimeType: answer.mimeType };
  const text = new TextDecoder().decode(bytes.subarray(0, PREVIEW_TEXT_CHARS * 4));
  return { kind, text: text.slice(0, PREVIEW_TEXT_CHARS) };
}
