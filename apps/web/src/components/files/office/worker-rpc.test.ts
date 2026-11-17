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

const open = () => {
  const worker = new FakeWorker();
  // SAFETY: the client only posts, terminates and listens, which FakeWorker implements.
  const client = createWorkerClient<Methods>(worker as unknown as Worker);
  const outcome = client.call("open", undefined).then(
    (value) => ({ value }),
    (error: Error) => ({ failed: error.message }),
  );
  const id = worker.sent[0]!.id;
  return { worker, outcome, id };
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
});
