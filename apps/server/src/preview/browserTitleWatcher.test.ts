import type { CDPSession } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import { makeBrowserTitleWatcher } from "./browserTitleWatcher.ts";

it("retires the deferred observer before watching again after a fence", async () => {
  const observation = Promise.withResolvers<{ result: { value: boolean } }>();
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<{ result: { value: boolean } }>();
  const send = vi.fn(
    async (method: string, opts?: { awaitPromise?: boolean; expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate" && opts?.awaitPromise) return observation.promise;
      cleanupStarted.resolve();
      return cleanup.promise;
    },
  );
  let allowed = true;
  const watcher = makeBrowserTitleWatcher({ send } as unknown as CDPSession, () => allowed);
  const onChanged = vi.fn(async () => {});
  await watcher.watch(1, "Original", onChanged);
  const installed = send.mock.calls.find(([method]) => method === "Runtime.evaluate")?.[1];
  expect(installed).toMatchObject({ contextId: 7, awaitPromise: true });
  const key = installed?.expression?.match(/goatPreviewTitle\d+/)?.[0];
  expect(key).toBeDefined();
  send.mockClear();
  allowed = false;
  watcher.stop();
  watcher.stop();
  await watcher.watch(2, "Denied", onChanged);
  expect(send).not.toHaveBeenCalled();

  allowed = true;
  const rearming = watcher.watch(2, "Allowed", onChanged);
  const firstReply = await Promise.race([
    cleanupStarted.promise.then(() => "cleanup"),
    rearming.then(() => "watch"),
  ]);
  expect(firstReply).toBe("cleanup");
  expect(send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  cleanup.resolve({ result: { value: false } });
  await rearming;
  expect(send.mock.calls.map(([method]) => method)).toEqual([
    "Runtime.evaluate",
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Runtime.evaluate",
  ]);
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    contextId: 7,
    expression: `globalThis[${JSON.stringify(key)}]?.()`,
  });
  watcher.stop();
  observation.resolve({ result: { value: false } });
});
