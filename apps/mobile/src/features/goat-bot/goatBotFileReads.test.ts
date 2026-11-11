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
  let started = false;
  return {
    run: () => {
      started = true;
      return promise;
    },
    started: () => started,
    resolve,
    reject,
  };
}

it("runs one read at a time on a server, and another server's reads beside it", async () => {
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

it("runs an open next after the preview in flight, ahead of every waiting preview, with the preview's answer kept", async () => {
  const env = environment();
  const room = chat();
  const [running, waiting, file] = [gate(), gate(), gate()];
  const runningRead = queuePreviewRead(env, room, running.run);
  queuePreviewRead(env, room, waiting.run);
  const opened = openBotFileRead(env, file.run);
  // Nothing overlaps on the connection: the open waits for the one chunk in flight.
  expect(file.started()).toBe(false);
  running.resolve("preview");
  expect(await runningRead.result).toBe("preview");
  await settle();
  expect(file.started()).toBe(true);
  expect(waiting.started()).toBe(false);
  file.resolve("file");
  expect(await opened).toBe("file");
  await settle();
  expect(waiting.started()).toBe(true);
});

it("finishes a whole opened file before any waiting preview, even while previews keep coming", async () => {
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
  running.resolve("preview");
  await settle();
  for (const [index, chunk] of chunks.entries()) {
    // Previews arriving between the open's chunks wait for the whole open.
    queuePreviewRead(env, room, gate().run);
    await settle();
    expect(chunk.started()).toBe(true);
    expect(waiting.started()).toBe(false);
    chunk.resolve(String(index));
    await settle();
  }
  expect(await opened).toBe("012");
  await settle();
  expect(waiting.started()).toBe(true);
});

it("runs two opens in the order they were asked, one at a time", async () => {
  const env = environment();
  const [first, second] = [gate(), gate()];
  const a = openBotFileRead(env, first.run);
  const b = openBotFileRead(env, second.run);
  expect([first.started(), second.started()]).toEqual([true, false]);
  first.resolve("a");
  expect(await a).toBe("a");
  await settle();
  expect(second.started()).toBe(true);
  second.resolve("b");
  expect(await b).toBe("b");
});

it("keeps only the newest previews waiting, and a cancelled one never issues its read", async () => {
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

it("settles an open aborted while it waits without reading, and an open that fails lets the next read go", async () => {
  const env = environment();
  const running = gate();
  queuePreviewRead(env, chat(), running.run);
  const controller = new AbortController();
  let read = false;
  const aborted = openBotFileRead(
    env,
    async () => {
      read = true;
      return "never";
    },
    controller.signal,
  );
  controller.abort();
  expect(await aborted).toBeNull();
  const failing = openBotFileRead(env, () => Promise.reject(new Error("offline")));
  const after = gate();
  queuePreviewRead(env, chat(), after.run);
  running.resolve("done");
  await expect(failing).rejects.toThrow("offline");
  await settle();
  expect(read).toBe(false);
  expect(after.started()).toBe(true);
});
