import type { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import {
  dropChatPreviewReads,
  MAX_WAITING_PREVIEW_READS,
  openBotFileRead,
  queuePreviewRead,
} from "./goatBotFileReads";

let next = 0;
// Each test gets its own environment and chat, so the module's queues never carry over between tests.
const environment = () => `env-${(next += 1)}` as EnvironmentId;
const chat = () => `chat-${(next += 1)}`;
// Lets the queue's promise callbacks run; nothing here waits on a clock.
const settle = async () => {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
};

function gate() {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let starts = 0;
  return {
    run: () => {
      starts += 1;
      return promise;
    },
    started: () => starts > 0,
    starts: () => starts,
    resolve,
    reject,
  };
}

it("runs one preview read at a time on a server, and another server's reads beside it", async () => {
  const env = environment();
  const room = chat();
  const [first, second, elsewhere] = [gate(), gate(), gate()];
  const a = queuePreviewRead(env, room, first.run);
  queuePreviewRead(env, room, second.run);
  queuePreviewRead(environment(), chat(), elsewhere.run);
  expect([first.started(), second.started(), elsewhere.started()]).toEqual([true, false, true]);
  first.resolve("a");
  expect(await a.result).toBe("a");
  await settle();
  expect(second.started()).toBe(true);
});

it("opens a file at once even while a preview never settles", async () => {
  const env = environment();
  const stuck = gate();
  queuePreviewRead(env, chat(), stuck.run);
  expect(stuck.started()).toBe(true);
  // The preview's answer never comes; the person's open does not wait for it.
  expect(await openBotFileRead(env, async () => "file")).toBe("file");
});

it("starts no waiting preview while an opened file is still being read, even as previews keep coming", async () => {
  const env = environment();
  const room = chat();
  const running = gate();
  queuePreviewRead(env, room, running.run);
  const waiting = gate();
  queuePreviewRead(env, room, waiting.run);
  const chunks = [gate(), gate(), gate()];
  const opened = openBotFileRead(env, async () => {
    let read = "";
    for (const chunk of chunks) read += await chunk.run();
    return read;
  });
  await settle();
  expect(chunks[0]?.started()).toBe(true);
  running.resolve("preview");
  await settle();
  for (const [index, chunk] of chunks.entries()) {
    // Two more arrive between chunks; with the interrupted one and `waiting`, four wait.
    if (index < 2) queuePreviewRead(env, room, gate().run);
    await settle();
    expect(chunk.started()).toBe(true);
    expect(waiting.started()).toBe(false);
    chunk.resolve(String(index));
    await settle();
  }
  expect(await opened).toBe("012");
  // The interrupted preview is read again first (its answer is already in), then the waiting one.
  await settle();
  await settle();
  expect(running.starts()).toBe(2);
  expect(waiting.started()).toBe(true);
});

it("keeps only the newest previews waiting, and a cancelled one never runs", async () => {
  const env = environment();
  const room = chat();
  const running = gate();
  queuePreviewRead(env, room, running.run);
  const waiting = Array.from({ length: MAX_WAITING_PREVIEW_READS + 1 }, () => gate());
  const reads = waiting.map((entry) => queuePreviewRead(env, room, entry.run));
  // The oldest waiting preview was pushed out.
  expect(await reads[0]?.result).toBeNull();
  reads[1]?.cancel();
  expect(await reads[1]?.result).toBeNull();
  running.resolve("done");
  await settle();
  expect(waiting[0]?.started()).toBe(false);
  expect(waiting[1]?.started()).toBe(false);
  expect(waiting[2]?.started()).toBe(true);
});

it("drops a chat's waiting previews when the person leaves it, and keeps another chat's", async () => {
  const env = environment();
  const [left, stays] = [chat(), chat()];
  const running = gate();
  queuePreviewRead(env, left, running.run);
  const [gone, kept] = [gate(), gate()];
  const goneRead = queuePreviewRead(env, left, gone.run);
  queuePreviewRead(env, stays, kept.run);
  dropChatPreviewReads(left);
  expect(await goneRead.result).toBeNull();
  running.resolve("late");
  await settle();
  expect(gone.started()).toBe(false);
  expect(kept.started()).toBe(true);
});

it("settles an aborted open without reading, and an open that fails lets the next preview go", async () => {
  const env = environment();
  const controller = new AbortController();
  controller.abort();
  let read = false;
  const aborted = openBotFileRead(
    env,
    async () => {
      read = true;
      return "never";
    },
    controller.signal,
  );
  expect(await aborted).toBeNull();
  expect(read).toBe(false);
  const failing = openBotFileRead(env, () => Promise.reject(new Error("offline")));
  const after = gate();
  queuePreviewRead(env, chat(), after.run);
  await expect(failing).rejects.toThrow("offline");
  await settle();
  expect(after.started()).toBe(true);
});

const busy = (read: string) => read === "busy";

it("interrupts the preview in flight, waits for its chunk after a busy answer, tries once more, then reads that preview again first", async () => {
  const env = environment();
  const room = chat();
  // Each read of the interrupted preview gets its own answer.
  const attempts = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
  let starts = 0;
  const interrupted = {
    run: () => attempts[starts++]!.promise,
    starts: () => starts,
    resolve: (value: string) => attempts[0]?.resolve(value),
  };
  const behind = gate();
  const interruptedRead = queuePreviewRead(env, room, interrupted.run);
  queuePreviewRead(env, room, behind.run);
  const file = gate();
  let tries = 0;
  const opened = openBotFileRead(
    env,
    async () => {
      tries += 1;
      return tries === 1 ? "busy" : file.run();
    },
    undefined,
    busy,
  );
  await settle();
  expect(tries).toBe(1);
  // The server answers the interrupted chunk; the open tries again and reads the file.
  interrupted.resolve("stale chunk");
  await settle();
  expect(tries).toBe(2);
  expect(interrupted.starts()).toBe(1);
  file.resolve("file");
  expect(await opened).toBe("file");
  await settle();
  // Read again ahead of the preview that waited behind it, and its card gets that answer.
  expect(interrupted.starts()).toBe(2);
  expect(behind.started()).toBe(false);
  attempts[1]?.resolve("fresh chunk");
  expect(await interruptedRead.result).toBe("fresh chunk");
  await settle();
  expect(behind.started()).toBe(true);
});

it("opens without waiting when the server was free, and an open aborted while it waits for the chunk tries no more", async () => {
  const env = environment();
  queuePreviewRead(env, chat(), gate().run);
  expect(await openBotFileRead(env, async () => "file", undefined, busy)).toBe("file");
  const hung = gate();
  queuePreviewRead(env, chat(), hung.run);
  await settle();
  const controller = new AbortController();
  let tries = 0;
  const waiting = openBotFileRead(
    env,
    async () => {
      tries += 1;
      return "busy";
    },
    controller.signal,
    busy,
  );
  await settle();
  controller.abort();
  expect(await waiting).toBeNull();
  expect(tries).toBe(1);
});
