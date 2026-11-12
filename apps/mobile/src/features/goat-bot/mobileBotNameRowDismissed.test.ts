import { expect, it, vi } from "vite-plus/test";

// Each storage write waits on two gates the test opens: protected data becoming available, then the
// write itself finishing. Nothing here counts promise turns.
const storage = vi.hoisted(() => {
  const waiters: Array<() => void> = [];
  return {
    gates: [] as Array<() => void>,
    writes: [] as Array<{ value: string; finish: () => void }>,
    stored: null as string | null,
    changed: () => {
      for (const wake of waiters.splice(0)) wake();
    },
    until: (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (ready() ? resolve() : waiters.push(check));
        check();
      }),
  };
});
vi.mock("../../lib/protectedData", () => ({
  whenProtectedDataAvailable: () =>
    new Promise<void>((resolve) => {
      storage.gates.push(resolve);
      storage.changed();
    }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: (_key: string, value: string) =>
    new Promise<void>((resolve) => {
      storage.writes.push({
        value,
        finish: () => {
          storage.stored = value;
          resolve();
        },
      });
      storage.changed();
    }),
}));

import { dismissBotNameRow } from "./mobileBotNameRowDismissed";

const key = (botId: string) => JSON.stringify(["env", botId]);
/** Lets write number `n` (1-based) start, waits for it, and finishes it. */
async function runWrite(n: number) {
  await storage.until(() => storage.gates.length >= n);
  storage.gates[n - 1]?.();
  await storage.until(() => storage.writes.length >= n);
  storage.writes[n - 1]?.finish();
}

it("writes one dismissal list at a time and stores the latest one", async () => {
  dismissBotNameRow("env" as never, "a");
  dismissBotNameRow("env" as never, "b");
  // The second dismissal waits for the write under way instead of racing it.
  expect(storage.gates).toHaveLength(1);
  await runWrite(1);
  await runWrite(2);
  expect(storage.gates).toHaveLength(2);
  expect(JSON.parse(storage.stored ?? "[]")).toEqual([key("a"), key("b")]);
});

it("keeps only the newest 200 dismissals", async () => {
  for (let index = 0; index < 205; index += 1) dismissBotNameRow("env" as never, `bot-${index}`);
  const first = storage.gates.length;
  await runWrite(first);
  await runWrite(first + 1);
  const kept = JSON.parse(storage.stored ?? "[]") as string[];
  expect(kept).toHaveLength(200);
  expect(kept.at(-1)).toBe(key("bot-204"));
  expect(kept).not.toContain(key("bot-4"));
});
