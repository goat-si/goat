import {
  CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
  CHANNEL_BOT_ARTIFACT_MAX_BYTES,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
  type ChannelTaskStatus,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

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
