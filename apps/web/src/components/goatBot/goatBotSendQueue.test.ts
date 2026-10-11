import { describe, expect, it } from "vite-plus/test";

import { createGoatBotSendQueue } from "./goatBotSendQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(canDispatch: () => boolean = () => true) {
  const calls: Array<{
    clientKey: string;
    text: string;
    reply: ReturnType<typeof deferred<{ requestKey: string }>>;
  }> = [];
  let key = 0;
  const queue = createGoatBotSendQueue({
    send: (message) => {
      const reply = deferred<{ requestKey: string }>();
      calls.push({ ...message, reply });
      return reply.promise;
    },
    canDispatch: () => canDispatch(),
    onChange: () => {},
    makeKey: () => `key-${++key}`,
    now: () => "2026-10-12T12:00:00Z",
  });
  return { queue, calls };
}

describe("createGoatBotSendQueue", () => {
  it("sends in order, one at a time, while still taking new messages", async () => {
    const { queue, calls } = setup();
    queue.submit("first");
    queue.submit("second");
    expect(calls.map((call) => call.text)).toEqual(["first"]);
    expect(queue.pendingInputs().map((entry) => entry.state)).toEqual(["sending", "sending"]);
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await flush();
    expect(calls.map((call) => call.text)).toEqual(["first", "second"]);
  });

  it("retries a failed message under the same key, once", async () => {
    const { queue, calls } = setup();
    const key = queue.submit("hello");
    calls[0]!.reply.reject(new Error("socket closed"));
    await flush();
    expect(queue.pendingInputs()[0]?.state).toBe("failed");
    queue.retry(key);
    queue.retry(key);
    expect(calls.map((call) => call.clientKey)).toEqual([key, key]);
    calls[1]!.reply.resolve({ requestKey: "in-1" });
    await flush();
    expect(queue.pendingInputs()[0]).toMatchObject({ clientKey: key, requestKey: "in-1" });
  });

  it("stops and marks waiting messages unsent when sending is no longer allowed", async () => {
    let allowed = true;
    const { queue, calls } = setup(() => allowed);
    queue.submit("first");
    queue.submit("second");
    allowed = false;
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(queue.pendingInputs().map((entry) => [entry.text, entry.state])).toEqual([
      ["first", "sending"],
      ["second", "failed"],
    ]);
  });

  it("forgets accepted messages once the server shows them", async () => {
    const { queue, calls } = setup();
    queue.submit("hello");
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await flush();
    queue.acknowledge(new Set(["in-1"]));
    expect(queue.pendingInputs()).toEqual([]);
  });
});
