import {
  EnvironmentId,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BOT_FILE_OPEN_CHUNK_BOUND_MS,
  BOT_FILE_PREVIEW_CHUNK_BOUND_MS,
  MAX_WAITING_BOT_FILE_OPENS,
  MAX_WAITING_BOT_FILE_PREVIEWS,
  createBotFileReads,
  type BotFileReadChunk,
} from "./fileReads.ts";

const A = EnvironmentId.make("server-a");
const B = EnvironmentId.make("server-b");

interface Call {
  readonly input: ChannelReadBotArtifactInput;
  /** The read's own promise, so a test can wait for the queue to see its answer. */
  readonly answered: Promise<ChannelReadBotArtifactResult>;
  readonly answer: (result: ChannelReadBotArtifactResult) => void;
  readonly fail: (error: unknown) => void;
}

/** A server whose chunk reads the test answers by hand; `call(n)` settles when the nth read arrives. */
function fakeServer() {
  const calls: Array<Call> = [];
  const arrivals: Array<{ readonly index: number; readonly resolve: (call: Call) => void }> = [];
  const readChunk: BotFileReadChunk = (input) => {
    const answer = Promise.withResolvers<ChannelReadBotArtifactResult>();
    const call = { input, answered: answer.promise, answer: answer.resolve, fail: answer.reject };
    // The queue never awaits a read it moved past; this keeps a late failure observed.
    answer.promise.catch(() => {});
    calls.push(call);
    for (const arrival of arrivals.filter((waiting) => waiting.index === calls.length - 1))
      arrival.resolve(call);
    return answer.promise;
  };
  return {
    readChunk,
    paths: () => calls.map((call) => call.input.relativePath + "@" + (call.input.offset ?? 0)),
    count: () => calls.length,
    call: (index: number) => {
      const seen = calls[index];
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise<Call>((resolve) => arrivals.push({ index, resolve }));
    },
  };
}

/** A fresh queue on fake timers, cleared and back on real timers when the test ends. */
function setup() {
  vi.useFakeTimers();
  const reads = createBotFileReads();
  return {
    reads,
    server: fakeServer(),
    [Symbol.dispose]: () => {
      reads.clear();
      vi.useRealTimers();
    },
  };
}

const encode = (text: string) => Base64.encode(new TextEncoder().encode(text));

/** A whole small file in one chunk. */
const chunk = (relativePath: string): ChannelReadBotArtifactResult => ({
  status: "chunk",
  relativePath,
  mimeType: "text/plain",
  size: relativePath.length,
  offset: 0,
  bytesBase64: encode(relativePath),
  version: "v1",
  done: true,
});

/** One half of the four-byte file "abcd". */
const half = (relativePath: string, second: boolean): ChannelReadBotArtifactResult => ({
  status: "chunk",
  relativePath,
  mimeType: "text/plain",
  size: 4,
  offset: second ? 2 : 0,
  bytesBase64: encode(second ? "cd" : "ab"),
  version: "v1",
  done: second,
});

const throwsAtOnce: BotFileReadChunk = () => {
  throw new Error("thrown before any promise");
};

describe("Library reads", () => {
  it("one chunk at a time per server, another server beside it; an open goes first and holds the server for its whole file", async () => {
    using test = setup();
    const { reads, server } = test;
    const first = reads.preview(A, server.readChunk, "first");
    reads.preview(A, server.readChunk, "older");
    reads.preview(B, server.readChunk, "elsewhere");
    const opened = reads.open(A, server.readChunk, "file");
    expect(server.paths()).toEqual(["first@0", "elsewhere@0"]);
    (await server.call(0)).answer(chunk("first"));
    await expect(first.result).resolves.toEqual({ status: "ready", answer: chunk("first") });
    (await server.call(2)).answer(half("file", false));
    // A preview asked between the open's chunks waits for the whole open.
    reads.preview(A, server.readChunk, "newer");
    (await server.call(3)).answer(half("file", true));
    await expect(opened).resolves.toMatchObject({ status: "ok", size: 4 });
    (await server.call(4)).answer(chunk("newer"));
    await server.call(5);
    expect(server.paths()).toEqual([
      "first@0",
      "elsewhere@0",
      "file@0",
      "file@2",
      "newer@0",
      "older@0",
    ]);
  });

  it("two opens run in the order they were asked, one at a time", async () => {
    using test = setup();
    const { reads, server } = test;
    const first = reads.open(A, server.readChunk, "one");
    const second = reads.open(A, server.readChunk, "two");
    expect(server.paths()).toEqual(["one@0"]);
    (await server.call(0)).answer(chunk("one"));
    await expect(first).resolves.toMatchObject({ status: "ok" });
    (await server.call(1)).answer(chunk("two"));
    await expect(second).resolves.toMatchObject({ status: "ok" });
  });

  it("R1: a chunk that never answers frees the lane at its bound; the next read runs; the late answer starts nothing", async () => {
    using test = setup();
    const { reads, server } = test;
    const stuck = reads.preview(A, server.readChunk, "stuck");
    reads.preview(A, server.readChunk, "next");
    await vi.advanceTimersByTimeAsync(BOT_FILE_PREVIEW_CHUNK_BOUND_MS - 1);
    expect(server.paths()).toEqual(["stuck@0"]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stuck.result).resolves.toEqual({ status: "failed" });
    await server.call(1);
    reads.preview(A, server.readChunk, "third");
    const late = await server.call(0);
    late.answer(chunk("stuck"));
    await late.answered;
    expect(server.paths()).toEqual(["stuck@0", "next@0"]);
    (await server.call(1)).answer(chunk("next"));
    await server.call(2);
    expect(server.paths()).toEqual(["stuck@0", "next@0", "third@0"]);
  });

  it("R1: a late answer after its lane emptied and a new read started on the recreated lane frees nothing and starts nothing", async () => {
    using test = setup();
    const { reads, server } = test;
    const stuck = reads.preview(A, server.readChunk, "stuck");
    await vi.advanceTimersByTimeAsync(BOT_FILE_PREVIEW_CHUNK_BOUND_MS);
    await expect(stuck.result).resolves.toEqual({ status: "failed" });
    const fresh = reads.preview(A, server.readChunk, "fresh");
    reads.preview(A, server.readChunk, "behind");
    expect(server.paths()).toEqual(["stuck@0", "fresh@0"]);
    const late = await server.call(0);
    late.answer(chunk("stuck"));
    await late.answered;
    expect(server.paths()).toEqual(["stuck@0", "fresh@0"]);
    (await server.call(1)).answer(chunk("fresh"));
    await expect(fresh.result).resolves.toMatchObject({ status: "ready" });
    await server.call(2);
    expect(server.paths()).toEqual(["stuck@0", "fresh@0", "behind@0"]);
  });

  it("R1: an open whose chunk runs past its bound answers busy and frees the server", async () => {
    using test = setup();
    const { reads, server } = test;
    const opened = reads.open(A, server.readChunk, "slow");
    reads.preview(A, server.readChunk, "next");
    await vi.advanceTimersByTimeAsync(BOT_FILE_OPEN_CHUNK_BOUND_MS);
    await expect(opened).resolves.toEqual({ status: "busy" });
    await server.call(1);
    expect(server.paths()).toEqual(["slow@0", "next@0"]);
  });

  it("R2: waiting previews run newest first; past 32 the oldest settles skipped", async () => {
    using test = setup();
    const { reads, server } = test;
    reads.preview(A, server.readChunk, "running");
    const waiting = Array.from({ length: MAX_WAITING_BOT_FILE_PREVIEWS + 1 }, (_, index) =>
      reads.preview(A, server.readChunk, "preview-" + index),
    );
    await expect(waiting[0]?.result).resolves.toEqual({ status: "skipped" });
    (await server.call(0)).answer(chunk("running"));
    const order = Array.from(
      { length: MAX_WAITING_BOT_FILE_PREVIEWS },
      (_, index) => "preview-" + (MAX_WAITING_BOT_FILE_PREVIEWS - index),
    );
    for (const [index, path] of order.entries()) {
      const call = await server.call(index + 1);
      expect(call.input.relativePath).toBe(path);
      call.answer(chunk(path));
    }
    await expect(waiting[1]?.result).resolves.toMatchObject({ status: "ready" });
    expect(server.count()).toBe(MAX_WAITING_BOT_FILE_PREVIEWS + 1);
  });

  it("R2: leaving a chat drops its waiting previews and keeps another chat's", async () => {
    using test = setup();
    const { reads, server } = test;
    reads.preview(A, server.readChunk, "running", "stays");
    const gone = reads.preview(A, server.readChunk, "gone", "left");
    reads.preview(A, server.readChunk, "kept", "stays");
    const goneToo = reads.preview(B, server.readChunk, "gone-elsewhere", "left");
    reads.leaveChat("left");
    await expect(gone.result).resolves.toEqual({ status: "cancelled" });
    await expect(goneToo.result).resolves.toEqual({ status: "cancelled" });
    (await server.call(0)).answer(chunk("running"));
    await server.call(2);
    expect(server.paths()).toEqual(["running@0", "gone-elsewhere@0", "kept@0"]);
  });

  it("R3: a read that fails frees the lane at once, for a preview and for an open", async () => {
    using test = setup();
    const { reads, server } = test;
    const failing = reads.preview(A, server.readChunk, "lost");
    const opened = reads.open(A, server.readChunk, "lost-open");
    (await server.call(0)).fail(new Error("connection lost"));
    await expect(failing.result).resolves.toEqual({ status: "failed" });
    (await server.call(1)).fail(new Error("offline"));
    await expect(opened).rejects.toThrow("offline");
    reads.preview(A, server.readChunk, "after");
    expect(server.paths()).toEqual(["lost@0", "lost-open@0", "after@0"]);
  });

  it("R4: a readChunk that throws before returning a promise, started at once, settles its caller and frees the lane", async () => {
    using test = setup();
    const { reads, server } = test;
    const failing = reads.open(A, throwsAtOnce, "throws");
    reads.preview(A, server.readChunk, "after");
    await expect(failing).rejects.toThrow("thrown before any promise");
    await server.call(0);
    expect(server.paths()).toEqual(["after@0"]);
  });

  it("R4: a waiting readChunk that throws before returning a promise settles its caller and frees the lane", async () => {
    using test = setup();
    const { reads, server } = test;
    reads.preview(A, server.readChunk, "running");
    reads.preview(A, server.readChunk, "after");
    const failing = reads.preview(A, throwsAtOnce, "throws");
    (await server.call(0)).answer(chunk("running"));
    await expect(failing.result).resolves.toEqual({ status: "failed" });
    await server.call(1);
    expect(server.paths()).toEqual(["running@0", "after@0"]);
  });

  it("R5: an open removes its abort listener when it settles", async () => {
    using test = setup();
    const { reads, server } = test;
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const opened = reads.open(A, server.readChunk, "file", controller.signal);
    (await server.call(0)).answer(chunk("file"));
    await expect(opened).resolves.toMatchObject({ status: "ok" });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });

  it("R6: aborting a running open answers null at once but keeps the lane until its chunk answers; the next read starts after", async () => {
    using test = setup();
    const { reads, server } = test;
    const controller = new AbortController();
    const opened = reads.open(A, server.readChunk, "file", controller.signal);
    reads.preview(A, server.readChunk, "next");
    controller.abort();
    let settled: unknown = "not settled";
    void opened.then((value) => (settled = value));
    // Runs pending promise work without moving the clock toward the chunk's bound.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeNull();
    expect(server.paths()).toEqual(["file@0"]);
    (await server.call(0)).answer(half("file", false));
    await server.call(1);
    expect(server.paths()).toEqual(["file@0", "next@0"]);
  });

  it("an open aborted during a chunk that then fails answers null once, rejects nothing, and frees the lane", async () => {
    using test = setup();
    const { reads, server } = test;
    const controller = new AbortController();
    const opened = reads.open(A, server.readChunk, "file", controller.signal);
    reads.preview(A, server.readChunk, "next");
    controller.abort();
    (await server.call(0)).fail(new Error("connection lost"));
    // An unhandled rejection after this point fails the run.
    await expect(opened).resolves.toBeNull();
    await server.call(1);
    expect(server.paths()).toEqual(["file@0", "next@0"]);
  });

  it("an open aborted between two chunks answers null at once, asks for no further chunk, and frees the lane", async () => {
    using test = setup();
    const { reads, server } = test;
    const controller = new AbortController();
    const opened = reads.open(A, server.readChunk, "file", controller.signal);
    reads.preview(A, server.readChunk, "next");
    (await server.call(0)).answer(half("file", false));
    controller.abort();
    await expect(opened).resolves.toBeNull();
    await server.call(1);
    expect(server.paths()).toEqual(["file@0", "next@0"]);
  });

  it("a file that changed while it was opened is read again once and shows", async () => {
    using test = setup();
    const { reads, server } = test;
    const opened = reads.open(A, server.readChunk, "file");
    (await server.call(0)).answer({ status: "changed", relativePath: "file" });
    (await server.call(1)).answer(chunk("file"));
    await expect(opened).resolves.toMatchObject({ status: "ok", size: 4 });
    expect(server.paths()).toEqual(["file@0", "file@0"]);
  });

  it("a file that changes on every read ends as changed after two reads, and frees the lane", async () => {
    using test = setup();
    const { reads, server } = test;
    const opened = reads.open(A, server.readChunk, "file");
    reads.preview(A, server.readChunk, "next");
    (await server.call(0)).answer({ status: "changed", relativePath: "file" });
    (await server.call(1)).answer({ status: "changed", relativePath: "file" });
    await expect(opened).resolves.toEqual({ status: "changed" });
    await server.call(2);
    expect(server.paths()).toEqual(["file@0", "file@0", "next@0"]);
  });

  it("cancelling a running preview, by its card or by leaving its chat, keeps the lane until its chunk answers or hits its bound", async () => {
    using test = setup();
    const { reads, server } = test;
    const card = reads.preview(A, server.readChunk, "card", "chat");
    reads.preview(A, server.readChunk, "next", "chat");
    card.cancel();
    await expect(card.result).resolves.toEqual({ status: "cancelled" });
    expect(server.paths()).toEqual(["card@0"]);
    (await server.call(0)).answer(chunk("card"));
    await server.call(1);
    reads.preview(A, server.readChunk, "last", "other");
    reads.leaveChat("chat");
    expect(server.paths()).toEqual(["card@0", "next@0"]);
    await vi.advanceTimersByTimeAsync(BOT_FILE_PREVIEW_CHUNK_BOUND_MS);
    await server.call(2);
    expect(server.paths()).toEqual(["card@0", "next@0", "last@0"]);
  });

  it("R7: a fifth waiting open returns busy, never null", async () => {
    using test = setup();
    const { reads, server } = test;
    reads.preview(A, server.readChunk, "running");
    const waiting = Array.from({ length: MAX_WAITING_BOT_FILE_OPENS }, (_, index) =>
      reads.open(A, server.readChunk, "open-" + index),
    );
    await expect(reads.open(A, server.readChunk, "fifth")).resolves.toEqual({ status: "busy" });
    (await server.call(0)).answer(chunk("running"));
    (await server.call(1)).answer(chunk("open-0"));
    await expect(waiting[0]).resolves.toMatchObject({ status: "ok" });
    expect(server.paths()).not.toContain("fifth@0");
  });

  it("R8: clear() settles running and waiting reads, leaves no timer, and a read right after runs at once", async () => {
    using test = setup();
    const { reads, server } = test;
    const running = reads.open(A, server.readChunk, "running");
    const waitingOpen = reads.open(A, server.readChunk, "waiting-open");
    const waitingPreview = reads.preview(A, server.readChunk, "waiting-preview");
    const elsewhere = reads.preview(B, server.readChunk, "elsewhere");
    reads.clear();
    await expect(running).resolves.toBeNull();
    await expect(waitingOpen).resolves.toBeNull();
    await expect(waitingPreview.result).resolves.toEqual({ status: "cancelled" });
    await expect(elsewhere.result).resolves.toEqual({ status: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    reads.preview(A, server.readChunk, "after");
    reads.preview(A, server.readChunk, "behind");
    expect(server.paths()).toEqual(["running@0", "elsewhere@0", "after@0"]);
    const late = await server.call(0);
    late.answer(chunk("running"));
    await late.answered;
    expect(server.paths()).toEqual(["running@0", "elsewhere@0", "after@0"]);
  });

  it("R9: an open aborted while it waits never reads, an aborted signal never queues, and a failing open lets the next read go", async () => {
    using test = setup();
    const { reads, server } = test;
    reads.preview(A, server.readChunk, "running");
    const controller = new AbortController();
    const aborted = reads.open(A, server.readChunk, "aborted", controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBeNull();
    await expect(reads.open(A, server.readChunk, "late", controller.signal)).resolves.toBeNull();
    const failing = reads.open(A, server.readChunk, "failing");
    reads.preview(A, server.readChunk, "after");
    (await server.call(0)).answer(chunk("running"));
    (await server.call(1)).fail(new Error("offline"));
    await expect(failing).rejects.toThrow("offline");
    await server.call(2);
    expect(server.paths()).toEqual(["running@0", "failing@0", "after@0"]);
  });
});
