import { expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  writes: [] as Array<{ value: string; finished: boolean; done: () => void }>,
  stored: null as string | null,
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => storage.stored,
  setItemAsync: (_key: string, value: string) =>
    new Promise<void>((resolve) => {
      const write = {
        value,
        finished: false,
        done: () => {
          if (write.finished) return;
          write.finished = true;
          storage.stored = value;
          resolve();
        },
      };
      storage.writes.push(write);
    }),
}));

import { dismissBotNameRow } from "./mobileBotNameRowDismissed";

const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};
/** Finishes the storage writes newest first, as a slow early write would. */
async function finishNewestFirst() {
  for (;;) {
    const pending = storage.writes.filter((write) => !write.finished);
    const newest = pending.at(-1);
    if (newest === undefined) return;
    newest.done();
    await settle();
  }
}

it("stores the latest set of dismissals even when an earlier write finishes last", async () => {
  dismissBotNameRow("env" as never, "a");
  await settle();
  dismissBotNameRow("env" as never, "b");
  await settle();
  // The second dismissal arrives while the first write is still under way.
  await finishNewestFirst();
  const kept = JSON.parse(storage.stored ?? "[]") as string[];
  expect(kept).toEqual([JSON.stringify(["env", "a"]), JSON.stringify(["env", "b"])]);
});

it("keeps only the newest 200 dismissals", async () => {
  for (let index = 0; index < 205; index += 1) dismissBotNameRow("env" as never, `bot-${index}`);
  await settle();
  await finishNewestFirst();
  const kept = JSON.parse(storage.stored ?? "[]") as string[];
  expect(kept).toHaveLength(200);
  expect(kept.at(-1)).toBe(JSON.stringify(["env", "bot-204"]));
  expect(kept).not.toContain(JSON.stringify(["env", "a"]));
});
