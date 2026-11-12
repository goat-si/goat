// @effect-diagnostics globalTimers:off - Library reads run in client promise code, outside an Effect runtime.
import {
  CHANNEL_BOT_ARTIFACT_ANSWER_BOUND_MS,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
  type EnvironmentId,
} from "@goat/contracts";

import { readWholeBotArtifact, type BotArtifactRead } from "./botArtifacts.ts";

// The server reads one Library file per connection at a time, so each server gets one chunk in
// flight; opens go first and hold it for their whole file. Every chunk has a bound. Nothing is
// asked again after busy, a bound or a failure; a file that changed while it was opened is read
// again once (readWholeBotArtifact), so one open makes at most two passes.

/** A preview's first chunk gets this past the server's bound; a full 512 KiB chunk (about 700 KB of base64) needs about 28 s at 200 kbit/s. */
const BOT_FILE_PREVIEW_TRANSFER_MS = 10_000;
/** Each chunk of an opened file gets this past the server's bound: a full 512 KiB chunk (about 700 KB of base64) at about 200 kbit/s. */
const BOT_FILE_OPEN_TRANSFER_MS = 40_000;
export const BOT_FILE_PREVIEW_CHUNK_BOUND_MS =
  CHANNEL_BOT_ARTIFACT_ANSWER_BOUND_MS + BOT_FILE_PREVIEW_TRANSFER_MS;
export const BOT_FILE_OPEN_CHUNK_BOUND_MS =
  CHANNEL_BOT_ARTIFACT_ANSWER_BOUND_MS + BOT_FILE_OPEN_TRANSFER_MS;
/** Opens waiting behind the one in flight; another answers busy at once. */
export const MAX_WAITING_BOT_FILE_OPENS = 4;
/** Previews waiting on one server; past this the oldest is skipped. */
export const MAX_WAITING_BOT_FILE_PREVIEWS = 32;

export type BotFileReadChunk = (
  input: ChannelReadBotArtifactInput,
) => Promise<ChannelReadBotArtifactResult>;

/** A busy, unanswered, thrown or rejected first chunk is `failed` and is not asked again. */
export type BotFilePreview =
  | { readonly status: "ready"; readonly answer: ChannelReadBotArtifactResult }
  | { readonly status: "failed" }
  | { readonly status: "skipped" }
  | { readonly status: "cancelled" };

export interface BotFilePreviewRead {
  readonly result: Promise<BotFilePreview>;
  /** The card went away: a waiting preview never runs; one in flight still holds the server until its chunk ends. */
  readonly cancel: () => void;
}

interface Entry {
  readonly chatKey: string | null;
  readonly start: () => void;
  /** Settles the caller; a read in flight still holds the server until its chunk ends. */
  readonly drop: (why: "cancelled" | "skipped") => void;
  /** Ends a read in flight at once: settles its caller and answers its chunk busy. */
  readonly stop: () => void;
}

interface Lane {
  running: Entry | null;
  readonly opens: Array<Entry>;
  /** Oldest first; the newest runs next. */
  readonly previews: Array<Entry>;
}

const BUSY: BotArtifactRead = { status: "busy" };
const FAILED: BotFilePreview = { status: "failed" };
const CANCELLED: BotFilePreview = { status: "cancelled" };

function removeFrom(list: Array<Entry>, entry: Entry): boolean {
  const at = list.indexOf(entry);
  if (at === -1) return false;
  list.splice(at, 1);
  return true;
}

// Web's TypeScript lib predates Promise.withResolvers.
function settler<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((onValue, onError) => {
    resolve = onValue;
    reject = onError;
  });
  return { promise, resolve, reject };
}

export function createBotFileReads() {
  const lanes = new Map<EnvironmentId, Lane>();

  const laneFor = (environmentId: EnvironmentId) => {
    const existing = lanes.get(environmentId);
    if (existing !== undefined) return existing;
    const lane: Lane = { running: null, opens: [], previews: [] };
    lanes.set(environmentId, lane);
    return lane;
  };

  const startNext = (environmentId: EnvironmentId, lane: Lane) => {
    if (lane.running !== null) return;
    const next = lane.opens.shift() ?? lane.previews.pop();
    if (next === undefined) {
      if (lanes.get(environmentId) === lane) lanes.delete(environmentId);
      return;
    }
    lane.running = next;
    next.start();
  };

  // The entry is the token: a late settle from a read that already left the lane frees nothing.
  const release = (environmentId: EnvironmentId, lane: Lane, entry: Entry) => {
    if (lane.running !== entry) return;
    lane.running = null;
    startNext(environmentId, lane);
  };

  /** One chunk with a bound and a way to end it early; past the bound it answers busy. */
  const chunk = (
    readChunk: BotFileReadChunk,
    input: ChannelReadBotArtifactInput,
    boundMs: number,
    onEnd: (end: (() => void) | null) => void,
  ) =>
    new Promise<ChannelReadBotArtifactResult>((resolve, reject) => {
      const busy = { status: "busy" as const, relativePath: input.relativePath };
      let ended = false;
      const end = (settle: () => void) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        onEnd(null);
        settle();
      };
      const timer = setTimeout(() => end(() => resolve(busy)), boundMs);
      onEnd(() => end(() => resolve(busy)));
      let answer: Promise<ChannelReadBotArtifactResult>;
      try {
        answer = readChunk(input);
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => end(() => resolve(value)),
        (error: unknown) => end(() => reject(error)),
      );
    });

  return {
    /**
     * A file the person opened: after the chunk in flight and ahead of every waiting preview, it
     * holds the server for its whole read. Null when aborted or cleared; busy when four opens are
     * already waiting. A chunk past its bound ends the read busy. Rejects when a chunk fails.
     */
    open(
      environmentId: EnvironmentId,
      readChunk: BotFileReadChunk,
      relativePath: string,
      signal?: AbortSignal,
    ): Promise<BotArtifactRead | null> {
      if (signal?.aborted) return Promise.resolve(null);
      const lane = laneFor(environmentId);
      if (lane.opens.length >= MAX_WAITING_BOT_FILE_OPENS) return Promise.resolve(BUSY);
      const settled = settler<BotArtifactRead | null>();
      let done = false;
      let stopped = false;
      let endChunk: (() => void) | null = null;
      let onAbort = () => {};
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const entry: Entry = {
        chatKey: null,
        start: () => {
          const bounded = (input: ChannelReadBotArtifactInput) =>
            stopped
              ? Promise.resolve({ status: "busy" as const, relativePath })
              : chunk(readChunk, input, BOT_FILE_OPEN_CHUNK_BOUND_MS, (end) => (endChunk = end));
          // An abort stops the read after the chunk in flight, which keeps the server until it ends.
          readWholeBotArtifact(relativePath, bounded, signal)
            .then(
              (read) => finish(() => settled.resolve(signal?.aborted ? null : read)),
              (error: unknown) => finish(() => settled.reject(error)),
            )
            .finally(() => release(environmentId, lane, entry));
        },
        drop: () => finish(() => settled.resolve(null)),
        stop: () => {
          stopped = true;
          finish(() => settled.resolve(null));
          endChunk?.();
        },
      };
      onAbort = () => {
        if (removeFrom(lane.opens, entry)) entry.drop("cancelled");
        // A running open answers at once; the lane stays held until its chunk in flight ends.
        else if (lane.running === entry) entry.drop("cancelled");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.opens.push(entry);
      startNext(environmentId, lane);
      return settled.promise;
    },

    /** A card's first chunk, in chat `chatKey` when given. */
    preview(
      environmentId: EnvironmentId,
      readChunk: BotFileReadChunk,
      relativePath: string,
      chatKey: string | null = null,
    ): BotFilePreviewRead {
      const lane = laneFor(environmentId);
      const settled = settler<BotFilePreview>();
      let done = false;
      let endChunk: (() => void) | null = null;
      const finish = (outcome: BotFilePreview) => {
        if (done) return;
        done = true;
        settled.resolve(outcome);
      };
      const entry: Entry = {
        chatKey,
        start: () => {
          chunk(
            readChunk,
            { relativePath },
            BOT_FILE_PREVIEW_CHUNK_BOUND_MS,
            (end) => (endChunk = end),
          )
            .then(
              (answer) => finish(answer.status === "busy" ? FAILED : { status: "ready", answer }),
              () => finish(FAILED),
            )
            .finally(() => release(environmentId, lane, entry));
        },
        drop: (why) => finish({ status: why }),
        stop: () => {
          finish(CANCELLED);
          endChunk?.();
        },
      };
      lane.previews.push(entry);
      if (lane.previews.length > MAX_WAITING_BOT_FILE_PREVIEWS)
        lane.previews.shift()?.drop("skipped");
      startNext(environmentId, lane);
      return {
        result: settled.promise,
        cancel: () => {
          removeFrom(lane.previews, entry);
          entry.drop("cancelled");
        },
      };
    },

    /** The person left chat `chatKey`: its waiting previews never run. */
    leaveChat(chatKey: string): void {
      for (const lane of lanes.values()) {
        for (const entry of lane.previews.filter((waiting) => waiting.chatKey === chatKey)) {
          removeFrom(lane.previews, entry);
          entry.drop("cancelled");
        }
        if (lane.running?.chatKey === chatKey) lane.running.drop("cancelled");
      }
    },

    /** Forgets every read: callers settle (an open null, a preview cancelled) and no timer is left. */
    clear(): void {
      for (const lane of lanes.values()) {
        const running = lane.running;
        lane.running = null;
        for (const entry of [...lane.opens.splice(0), ...lane.previews.splice(0)])
          entry.drop("cancelled");
        running?.stop();
      }
      lanes.clear();
    },
  };
}

export type BotFileReads = ReturnType<typeof createBotFileReads>;

/** Library reads for this client: one lane per server. */
export const botFileReads = createBotFileReads();
