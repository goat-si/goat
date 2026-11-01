import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createGoatBotSendQueue } from "./sendQueue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const bot = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };

function setup(canDispatch: () => boolean = () => true) {
  const calls: Array<{
    clientKey: string;
    text: string;
    reply: ReturnType<typeof deferred<{ requestKey: string }>>;
  }> = [];
  let key = 0;
  const changed = vi.fn();
  const queue = createGoatBotSendQueue({
    send: (message) => {
      const reply = deferred<{ requestKey: string }>();
      calls.push({ ...message, reply });
      return reply.promise;
    },
    canDispatch: () => canDispatch(),
    onChange: changed,
    makeKey: () => `key-${++key}`,
    now: () => "2026-10-12T12:00:00Z",
  });
  return { queue, calls, changed };
}

describe("createGoatBotSendQueue", () => {
  it("sends in order, one at a time, while still taking new messages", async () => {
    const { queue, calls } = setup();
    queue.submit("first", bot);
    queue.submit("second", bot);
    expect(calls.map((call) => call.text)).toEqual(["first"]);
    expect(queue.pendingInputs().map((entry) => entry.state)).toEqual(["sending", "queued"]);
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await vi.waitFor(() => expect(calls.map((call) => call.text)).toEqual(["first", "second"]));
  });

  it("retries a failed message under the same key, once", async () => {
    const { queue, calls } = setup();
    const key = queue.submit("hello", bot);
    calls[0]!.reply.reject(new Error("socket closed"));
    await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("failed"));
    queue.retry(key);
    queue.retry(key);
    expect(calls.map((call) => call.clientKey)).toEqual([key, key]);
    calls[1]!.reply.resolve({ requestKey: "in-1" });
    await vi.waitFor(() =>
      expect(queue.pendingInputs()[0]).toMatchObject({ clientKey: key, requestKey: "in-1" }),
    );
  });

  it("stops and marks waiting messages unsent when sending is no longer allowed", async () => {
    let allowed = true;
    const { queue, calls } = setup(() => allowed);
    queue.submit("first", bot);
    queue.submit("second", bot);
    allowed = false;
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await vi.waitFor(() => expect(queue.pendingInputs()[1]?.state).toBe("failed"));
    expect(calls).toHaveLength(1);
    expect(queue.pendingInputs().map((entry) => [entry.text, entry.state])).toEqual([
      ["first", "accepted"],
      ["second", "failed"],
    ]);
  });

  it("forgets accepted messages once the server shows them", async () => {
    const { queue, calls } = setup();
    queue.submit("hello", bot);
    calls[0]!.reply.resolve({ requestKey: "in-1" });
    await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("accepted"));
    queue.acknowledge(new Set(["in-1"]));
    expect(queue.pendingInputs()).toEqual([]);
  });
});

it("keeps the submit-time bot and receivedAt through a failed attempt and retry", async () => {
  let clock = "2026-10-12T12:00:00Z";
  const calls: Array<{ clientKey: string; text: string; receivedAt: string; bot: typeof bot }> = [];
  const attempt = deferred<{ requestKey: string }>();
  const queue = createGoatBotSendQueue({
    send: async (message) => {
      calls.push(message);
      return calls.length === 1 ? attempt.promise : { requestKey: "input" };
    },
    canDispatch: () => true,
    onChange: () => {},
    now: () => clock,
    makeKey: () => "fixed-key",
  });
  const selected = { ...bot };
  queue.submit("original", selected);
  selected.threadId = ThreadId.make("different-bot");
  clock = "2026-10-12T13:00:00Z";
  attempt.reject(new Error("connection lost"));
  await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("failed"));
  queue.retry("fixed-key");
  await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("accepted"));
  expect(calls).toEqual([
    { clientKey: "fixed-key", text: "original", receivedAt: "2026-10-12T12:00:00Z", bot },
    { clientKey: "fixed-key", text: "original", receivedAt: "2026-10-12T12:00:00Z", bot },
  ]);
  expect(queue.pendingInputs()[0]?.state).toBe("accepted");
});

it("remembers projected input IDs before the receipt and removes the accepted entry when it arrives", async () => {
  const { queue, calls } = setup();
  queue.submit("hello", bot);
  queue.acknowledge(new Set(["input-id"]));
  calls[0]!.reply.resolve({ requestKey: "input-id" });
  await vi.waitFor(() => expect(queue.pendingInputs()).toEqual([]));
});

it("removes a projected client key even when the receipt is lost and never retries it", async () => {
  const { queue, calls, changed } = setup();
  const key = queue.submit("hello", bot);
  queue.acknowledge(new Set([key]));
  const changes = changed.mock.calls.length;
  calls[0]!.reply.reject(new Error("lost receipt"));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(changes + 1));
  queue.retry(key);
  expect(queue.pendingInputs()).toEqual([]);
  expect(calls).toHaveLength(1);
});

it("does not hold later messages after failure and sends a retry at retry time", async () => {
  const { queue, calls } = setup();
  const key = queue.submit("first", bot);
  queue.submit("second", bot);
  calls[0]!.reply.reject(new Error("offline"));
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  calls[1]!.reply.resolve({ requestKey: "input-2" });
  await vi.waitFor(() => expect(queue.pendingInputs()[1]?.state).toBe("accepted"));
  queue.retry(key);
  expect(calls.map((call) => call.text)).toEqual(["first", "second", "first"]);
  calls[2]!.reply.resolve({ requestKey: "input-1" });
  await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("accepted"));
});

it("never retries a final rejected input even through the queue API", async () => {
  const queue = createGoatBotSendQueue({
    send: async () => ({ requestKey: "rejected", rejected: "Account is not linked" }),
    canDispatch: () => true,
    onChange: () => {},
    makeKey: () => "key",
  });
  queue.submit("hello", bot);
  await vi.waitFor(() => expect(queue.pendingInputs()[0]?.state).toBe("failed"));
  expect(queue.pendingInputs()[0]).toMatchObject({
    state: "failed",
    rejectionReason: "Account is not linked",
  });
  queue.retry("key");
  expect(queue.pendingInputs()[0]?.state).toBe("failed");
});
