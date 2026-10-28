import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import {
  makeMailbox,
  publishMailbox,
  readMailbox,
  loopWatchdogWorkerSource,
} from "./LoopWatchdogWorker.ts";
it("publishes bounded coherent progress and never revives a retired generation", () => {
  const mailbox = makeMailbox();
  expect(publishMailbox(mailbox, "ready")).toBe(true);
  expect(readMailbox(mailbox)).toMatchObject({ sequence: 1, phase: "ready", ready: true });
  Atomics.store(mailbox, 4, 1);
  expect(publishMailbox(mailbox, "ready")).toBe(false);
  expect(readMailbox(mailbox)?.sequence).toBe(1);
});

it("real embedded observer keeps sampling behind a held health write and retires its captured process once", () => {
  const mailbox = makeMailbox();
  let now = 0;
  let tick: (() => void) | undefined;
  let fallback: (() => void) | undefined;
  let writes = 0;
  const kills: Array<[number, string]> = [];
  const messages: string[] = [];
  const source = loopWatchdogWorkerSource();
  NodeVM.runInNewContext(source, {
    require: (name: string) =>
      name === "node:worker_threads"
        ? {
            workerData: { mailbox: mailbox.buffer, generation: "A", pid: 741, healthFd: 8 },
            parentPort: { postMessage: (value: string) => messages.push(value) },
          }
        : {
            write: () => {
              writes++;
            },
          },
    performance: { now: () => now },
    Buffer,
    Int32Array,
    Atomics,
    setInterval: (callback: () => void) => {
      tick = callback;
    },
    setTimeout: (callback: () => void) => {
      fallback = callback;
    },
    process: { kill: (pid: number, signal: string) => kills.push([pid, signal]) },
  });
  expect(messages).toEqual(["installed"]);
  for (let beat = 0; beat < 30; beat++) {
    now += 2000;
    publishMailbox(mailbox, "ready");
    tick?.();
  }
  expect(writes).toBe(1);
  expect(kills).toEqual([]);
  expect(fallback).toBeUndefined();
  Atomics.add(mailbox, 0, 1);
  for (let beat = 0; beat < 24; beat++) {
    now += 2000;
    tick?.();
  }
  expect(publishMailbox(mailbox, "ready")).toBe(false);
  fallback?.();
  expect(kills).toEqual([[741, "SIGKILL"]]);
  expect(writes).toBe(1);
});
