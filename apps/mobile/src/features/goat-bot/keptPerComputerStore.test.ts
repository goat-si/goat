import { BotProfile, ChannelListOpenAsksResult, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { createKeptSummaryStore } from "./keptSummaryStore";

const env = EnvironmentId.make("one");
const otherEnv = EnvironmentId.make("two");
const scope = "pairing-a";
const readAt = 1_700_000_000_000;
const week = 7 * 24 * 60 * 60 * 1000;
const at = "2026-11-20T10:42:00.000Z";
const bot = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: "🦉",
  purpose: "Private instructions",
  defaultProjectId: null,
  defaultModelSelection: null,
  environmentId: env,
  sessionThreadId: "private-thread",
  createdAt: at,
  updatedAt: at,
});
const asks = Schema.decodeUnknownSync(ChannelListOpenAsksResult)({
  asks: [
    {
      botId: "scout",
      kind: "approval",
      taskId: "task",
      text: "Private question text",
      requestId: "private request id",
      askedAt: at,
    },
  ],
  total: 1,
  truncated: false,
});

function device() {
  const values = new Map<string, string>();
  const key = (id: EnvironmentId, kind: string) => JSON.stringify([id, kind]);
  const storage = {
    read: async (id: EnvironmentId, kind: string) => values.get(key(id, kind)) ?? null,
    write: async (id: EnvironmentId, kind: string, value: string) => {
      values.set(key(id, kind), value);
    },
    remove: async (id: EnvironmentId, kind: string) => {
      values.delete(key(id, kind));
    },
    clear: async () => values.clear(),
  };
  return { values, storage, open: () => createKeptSummaryStore(storage) };
}

it("restores only roster rows and ask metadata for the same pairing and environment", async () => {
  const phone = device();
  const first = phone.open();
  await first.keep(first.lease(env), "bots", scope, readAt, { bots: [bot] });
  await first.keep(first.lease(env), "asks", scope, readAt, asks);

  const reopened = phone.open();
  expect(await reopened.restore(reopened.lease(env), "bots", [scope], readAt + 1)).toEqual({
    kind: "bots",
    scope,
    readAt,
    data: [{ botId: "scout", role: "member", name: "Scout", avatar: "🦉" }],
  });
  expect(await reopened.restore(reopened.lease(env), "asks", [scope], readAt + 1)).toEqual({
    kind: "asks",
    scope,
    readAt,
    data: {
      asks: [{ botId: "scout", kind: "approval", taskId: "task", askedAt: at }],
      total: 1,
      truncated: false,
    },
  });
  expect(await reopened.restore(reopened.lease(env), "asks", ["pairing-b"], readAt + 1)).toBeNull();
  expect(await reopened.restore(reopened.lease(otherEnv), "asks", [scope], readAt + 1)).toBeNull();
  const disk = [...phone.values.values()].join("");
  expect(disk).not.toMatch(
    /Private question text|private request id|Private instructions|private-thread/,
  );
});

it("removes a summary when it reaches seven days", async () => {
  const phone = device();
  const store = phone.open();
  await store.keep(store.lease(env), "asks", scope, readAt, asks);
  expect(await store.restore(store.lease(env), "asks", [scope], readAt + week - 1)).not.toBeNull();
  expect(await store.restore(store.lease(env), "asks", [scope], readAt + week)).toBeNull();
  expect(phone.values.size).toBe(0);
});

it("purges a refusing or removed environment and rejects earlier reads", async () => {
  const phone = device();
  const store = phone.open();
  const inFlight = store.lease(env);
  await store.keep(inFlight, "asks", scope, readAt, asks);
  await store.keep(store.lease(otherEnv), "asks", scope, readAt, asks);

  await store.purge(env);
  await store.keep(inFlight, "asks", scope, readAt + 1, asks);
  expect(await store.restore(store.lease(env), "asks", [scope], readAt + 1)).toBeNull();
  expect(await store.restore(store.lease(otherEnv), "asks", [scope], readAt + 1)).not.toBeNull();
});

it("on sign-out, discards disk restores and writes that were already in flight", async () => {
  const phone = device();
  const store = phone.open();
  const inFlight = store.lease(env);
  await store.keep(inFlight, "asks", scope, readAt, asks);
  const originalRead = phone.storage.read;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { promise: started, resolve: enter } = Promise.withResolvers<void>();
  phone.storage.read = async (...args) => {
    const value = await originalRead(...args);
    enter();
    await pending;
    return value;
  };

  const restoring = store.restore(inFlight, "asks", [scope], readAt);
  await started;
  const signedOut = store.purgeAll();
  release();
  expect(await restoring).toBeNull();
  await signedOut;
  await store.keep(inFlight, "asks", scope, readAt + 1, asks);
  expect(phone.values.size).toBe(0);
});

it("an earlier read cannot replace a newer summary after pairing verification finishes late", async () => {
  const store = device().open();
  const lease = store.lease(env);
  await store.keep(lease, "asks", scope, readAt + 1, { ...asks, asks: [], total: 0 });
  await store.keep(lease, "asks", scope, readAt, asks);
  expect(await store.restore(lease, "asks", [scope], readAt + 2)).toMatchObject({
    readAt: readAt + 1,
    data: { asks: [], total: 0 },
  });
});
