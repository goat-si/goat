import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkerClient, type Method } from "./worker-rpc";

/** The window's view of a worker: what it was sent, and a way to answer as the worker would. */
class FakeWorker extends EventTarget {
  readonly sent: { readonly id: number }[] = [];
  postMessage(message: { readonly id: number }) {
    this.sent.push(message);
  }
  terminate() {}
  answer(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

type Methods = { readonly open: Method<undefined, string> };

const settle = (call: Promise<string>) =>
  call.then(
    (value) => ({ value }),
    (error: Error) => ({ failed: error.message }),
  );

const open = () => {
  const worker = new FakeWorker();
  // SAFETY: the client only posts, terminates and listens, which FakeWorker implements.
  const client = createWorkerClient<Methods>(worker as unknown as Worker);
  const outcome = settle(client.call("open", undefined));
  const id = worker.sent[0]!.id;
  return { worker, client, outcome, id };
};

describe("the per-call deadline", () => {
  it("does not run while the worker waits on font downloads, which have their own bound", async () => {
    vi.useFakeTimers();
    try {
      const { worker, outcome, id } = open();
      worker.answer({ wait: id, waiting: true });
      await vi.advanceTimersByTimeAsync(120_000);
      worker.answer({ wait: id, waiting: false });
      await vi.advanceTimersByTimeAsync(29_000);
      worker.answer({ id, ok: true, value: "opened", transferred: [] });

      expect(await outcome).toEqual({ value: "opened" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the call 30 seconds again once the wait ends", async () => {
    vi.useFakeTimers();
    try {
      const { worker, outcome, id } = open();
      worker.answer({ wait: id, waiting: true });
      await vi.advanceTimersByTimeAsync(60_000);
      worker.answer({ wait: id, waiting: false });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await outcome).toEqual({
        failed: "This document took too long to preview. Open it in another app.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run for a call queued behind a font download, which gets 30 seconds once it ends", async () => {
    vi.useFakeTimers();
    try {
      const { worker, client, outcome, id } = open();
      worker.answer({ wait: id, waiting: true });
      await vi.advanceTimersByTimeAsync(10_000);
      const queued = settle(client.call("open", undefined));
      const queuedId = worker.sent.at(-1)!.id;
      await vi.advanceTimersByTimeAsync(110_000);
      worker.answer({ wait: id, waiting: false });
      await vi.advanceTimersByTimeAsync(29_000);
      worker.answer({ id, ok: true, value: "first", transferred: [] });
      worker.answer({ id: queuedId, ok: true, value: "second", transferred: [] });

      expect([await outcome, await queued]).toEqual([{ value: "first" }, { value: "second" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a call queued behind a font download 30 seconds after the download ends", async () => {
    vi.useFakeTimers();
    try {
      const { worker, client, outcome, id } = open();
      worker.answer({ wait: id, waiting: true });
      const queued = settle(client.call("open", undefined));
      await vi.advanceTimersByTimeAsync(120_000);
      worker.answer({ wait: id, waiting: false });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await queued).toEqual({
        failed: "This document took too long to preview. Open it in another app.",
      });
      expect(await outcome).toEqual(await queued);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a later call paused while a download that an aborted call started is still open", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      // SAFETY: the client only posts, terminates and listens, which FakeWorker implements.
      const client = createWorkerClient<Methods>(worker as unknown as Worker);
      const controller = new AbortController();
      const aborted = settle(client.call("open", undefined, { signal: controller.signal }));
      const abortedId = worker.sent[0]!.id;
      worker.answer({ wait: abortedId, waiting: true });
      controller.abort();
      const later = settle(client.call("open", undefined));
      const laterId = worker.sent.at(-1)!.id;
      await vi.advanceTimersByTimeAsync(120_000);
      worker.answer({ wait: abortedId, waiting: false });
      await vi.advanceTimersByTimeAsync(29_000);
      worker.answer({ id: laterId, ok: true, value: "painted", transferred: [] });

      expect([await aborted, await later]).toEqual([
        { failed: "The call was aborted" },
        { value: "painted" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
