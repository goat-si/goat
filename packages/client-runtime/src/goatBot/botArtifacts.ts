import {
  CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
  CHANNEL_BOT_ARTIFACT_MAX_BYTES,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
  type ChannelTaskStatus,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

import { goatBotDayLabel } from "./labels.ts";

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

/**
 * Library files a reply names in inline code, in order, each once: by its path inside the
 * artifacts folder, or by a full path ending in that folder and path.
 */
export function goatBotReplyFiles<File extends { readonly relativePath: string }>(
  text: string,
  files: ReadonlyArray<File>,
): ReadonlyArray<File> {
  const named: Array<File> = [];
  for (const match of text.matchAll(INLINE_CODE)) {
    const code = (match[1] ?? "").trim();
    const file = files.find(
      (candidate) =>
        code === candidate.relativePath || code.endsWith(`/artifacts/${candidate.relativePath}`),
    );
    if (file !== undefined && !named.includes(file)) named.push(file);
  }
  return named;
}

/** True when a reply has inline code that could name a saved file, so the Library is worth reading. */
export function goatBotReplyMayNameFile(text: string): boolean {
  for (const match of text.matchAll(INLINE_CODE))
    if (/[^/\s]\.[A-Za-z0-9]{1,8}$/.test((match[1] ?? "").trim())) return true;
  return false;
}

const TEXT_TYPES = new Set(["application/json", "text/csv"]);
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
  return "download";
}

/** Newest-first Library files under one heading per local calendar day, order kept. */
export function goatBotArtifactDays<File extends { readonly modifiedAt: string }>(
  files: ReadonlyArray<File>,
  nowMs: number,
): ReadonlyArray<{ readonly label: string; readonly files: ReadonlyArray<File> }> {
  const days: Array<{ label: string; files: File[] }> = [];
  for (const file of files) {
    const label = goatBotDayLabel(file.modifiedAt, nowMs);
    const last = days.at(-1);
    if (last?.label === label) last.files.push(file);
    else days.push({ label, files: [file] });
  }
  return days;
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
      return "Another file is still opening. Try again in a moment.";
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

export interface BotComputer {
  /** Null for GOAT Bot's own machine. */
  readonly host: string | null;
  readonly tasks: ReadonlyArray<BotComputerTask>;
}

/**
 * The machines GOAT Bot's running work uses. A task with a worker is where its worker is (no host
 * means GOAT Bot's own machine); a task still waiting for one is where it was asked to run.
 */
export function botComputers(tasks: ReadonlyArray<BotComputerTask>): ReadonlyArray<BotComputer> {
  const running = new Set<string>(BOT_RUNNING_TASK_STATUSES);
  const groups = new Map<string | null, BotComputerTask[]>();
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
