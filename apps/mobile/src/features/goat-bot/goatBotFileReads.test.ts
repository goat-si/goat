import type { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { MAX_WAITING_PREVIEW_READS, openBotFileRead, queuePreviewRead } from "./goatBotFileReads";

let next = 0;
// Each test gets its own environment, so the module's queues never carry over between tests.
const environment = () => `env-${(next += 1)}` as EnvironmentId;
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
  const [first, second, elsewhere] = [gate(), gate(), gate()];
  const a = queuePreviewRead(env, first.run);
  queuePreviewRead(env, second.run);
  queuePreviewRead(environment(), elsewhere.run);
  expect([first.started(), second.started(), elsewhere.started()]).toEqual([true, false, true]);
  first.resolve("a");
  expect(await a.result).toBe("a");
  await settle();
  expect(second.started()).toBe(true);
});

it("finishes a whole opened file before any waiting preview, even while previews keep coming", async () => {
  const env = environment();
  const running = gate();
  queuePreviewRead(env, running.run);
  const waiting = gate();
  queuePreviewRead(env, waiting.run);
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
    queuePreviewRead(env, gate().run);
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

it("keeps only the newest previews waiting, and a cancelled one never runs", async () => {
  const env = environment();
  const running = gate();
  queuePreviewRead(env, running.run);
  const waiting = Array.from({ length: MAX_WAITING_PREVIEW_READS + 1 }, () => gate());
  const reads = waiting.map((entry) => queuePreviewRead(env, entry.run));
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

it("settles an open aborted while it waits without reading, and an open that fails lets the next read go", async () => {
  const env = environment();
  const running = gate();
  queuePreviewRead(env, running.run);
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
  queuePreviewRead(env, after.run);
  running.resolve("done");
  await expect(failing).rejects.toThrow("offline");
  await settle();
  expect(read).toBe(false);
  expect(after.started()).toBe(true);
});
