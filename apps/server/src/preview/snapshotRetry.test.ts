import { describe, expect, it } from "vite-plus/test";

import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { SECRETS_PAGE_CHANGED } from "./pageSecrets.ts";
import { readFailure } from "./pageScope.ts";
import {
  pageChanged,
  snapshotRetry,
  tooBusy,
  transientCapture,
  type SnapshotRetryInput,
} from "./snapshotRetry.ts";

const changed = new Error("The page changed while capturing its snapshot. Take another snapshot.");
const busy = new Error("too busy");
const final = new Error("not retried");

/** A page on an injected clock: captures fail while it is still loading, or always when it keeps changing. */
const page = (options: { remainingMs: number; loads?: boolean; keepsChanging?: boolean }) => {
  let at = 0;
  let loaded = options.loads === undefined;
  const calls = { captures: 0, waits: [] as number[], sleeps: [] as number[] };
  const input: SnapshotRetryInput<string> = {
    capture: async () => {
      calls.captures += 1;
      if (!loaded || options.keepsChanging) throw changed;
      return "snapshot";
    },
    waitForLoad: async (timeoutMs) => {
      calls.waits.push(timeoutMs);
      if (options.loads) loaded = true;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      at += ms;
    },
    now: () => at,
    deadline: options.remainingMs,
    current: () => true,
    retryable: (cause) => cause !== final,
    tooBusy: () => busy,
  };
  return { input, calls };
};

describe("snapshot retry", () => {
  it("a snapshot taken while the page is still loading waits for load and succeeds", async () => {
    const { input, calls } = page({ remainingMs: 10_000, loads: true });
    await expect(snapshotRetry(input)).resolves.toBe("snapshot");
    expect(calls.waits).toEqual([9_500]);
    expect(calls.captures).toBe(2);
  });

  it("a loaded page that keeps changing gives up after three captures", async () => {
    const { input, calls } = page({ remainingMs: 10_000, keepsChanging: true });
    await expect(snapshotRetry(input)).rejects.toBe(busy);
    expect(calls.captures).toBe(3);
    expect(calls.sleeps).toEqual([250, 250]);
  });

  it("without a positive wait left it fails as too busy instead of waiting without a timeout", async () => {
    for (const remainingMs of [500, 749]) {
      const { input, calls } = page({ remainingMs, loads: true });
      await expect(snapshotRetry(input)).rejects.toBe(busy);
      expect(calls.waits).toEqual([]);
      expect(calls.captures).toBe(1);
    }
    const { input, calls } = page({ remainingMs: 750, loads: true });
    await expect(snapshotRetry(input)).resolves.toBe("snapshot");
    expect(calls.waits).toEqual([250]);
  });

  it("a failure that is not retried, or a newer snapshot, ends it at once", async () => {
    const refused = page({ remainingMs: 10_000, loads: true });
    refused.input = { ...refused.input, capture: async () => Promise.reject(final) };
    await expect(snapshotRetry(refused.input)).rejects.toBe(final);
    const replaced = page({ remainingMs: 10_000, loads: true });
    await expect(snapshotRetry({ ...replaced.input, current: () => false })).rejects.toBe(changed);
    expect(replaced.calls.captures).toBe(1);
  });
});

it("only an interrupted capture is retried; a scope that matches two elements fails as itself", async () => {
  expect(transientCapture(pageChanged())).toBe(true);
  expect(transientCapture(tooBusy())).toBe(true);
  const ambiguous = readFailure("scope_ambiguous");
  expect(transientCapture(ambiguous)).toBe(false);
  let captures = 0;
  const failing = snapshotRetry({
    capture: async () => {
      captures += 1;
      throw ambiguous;
    },
    waitForLoad: async () => undefined,
    sleep: async () => undefined,
    now: () => 0,
    deadline: 10_000,
    current: () => true,
    retryable: transientCapture,
    tooBusy,
  });
  await expect(failing).rejects.toBe(ambiguous);
  expect(captures).toBe(1);
});

it("a page change the secret readers saw is retried like one the capture saw", () => {
  expect(
    transientCapture(
      new ServerBrowserOperationError("PreviewAutomationExecutionError", SECRETS_PAGE_CHANGED),
    ),
  ).toBe(true);
});
