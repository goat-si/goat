import { ThreadId } from "@goat/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { ServerTab } from "./ServerBrowserTab.ts";
import { tabKey } from "./ServerBrowserPointer.ts";
import * as NodeEvents from "node:events";
import type { Dialog, Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  acceptClosingDialog,
  closeServerPage,
  makeBeforePreviewClose,
  unloadDesktopPage,
} from "./ServerBrowserClose.ts";
function fixture() {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  const contextClosed = Promise.withResolvers<void>();
  const watched = Promise.withResolvers<void>();
  let binding: (() => void) | undefined;
  const context = {
    close: vi.fn(async () => {
      contextClosed.resolve();
    }),
  };
  const page = {
    once: (event: string, cb: () => void) => events.once(event, cb),
    isClosed: () => closed,
    context: () => context,
    exposeFunction: vi.fn(async (_name: string, cb: () => void) => {
      binding = cb;
      watched.resolve();
    }),
    evaluate: vi.fn(async () => {}),
    close: vi.fn(async (options?: { runBeforeUnload?: boolean }) => {
      if (options?.runBeforeUnload) return;
      closed = true;
      events.emit("close");
    }),
  };
  return {
    page: page as unknown as Page,
    raw: page,
    context,
    watched,
    contextClosed,
    hidden: () => binding?.(),
    finish: () => {
      closed = true;
      events.emit("close");
    },
  };
}
afterEach(() => vi.useRealTimers());
it("waits for an isolated page to finish before closing its context", async () => {
  const f = fixture();
  closeServerPage(f.page, true, false);
  expect(f.raw.close).toHaveBeenCalledWith({ runBeforeUnload: true });
  expect(f.context.close).not.toHaveBeenCalled();
  f.finish();
  await f.contextClosed.promise;
});
it("force closes a page that does not finish unloading", async () => {
  vi.useFakeTimers();
  const f = fixture();
  closeServerPage(f.page, true, false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.raw.close).toHaveBeenCalledWith();
  expect(f.context.close).toHaveBeenCalledOnce();
});
it("waits for desktop pagehide before releasing the tab", async () => {
  const f = fixture();
  const result = unloadDesktopPage(f.page);
  expect(f.raw.exposeFunction).toHaveBeenCalledOnce();
  await f.watched.promise;
  await Promise.resolve();
  expect(f.raw.close).toHaveBeenCalledWith({ runBeforeUnload: true });
  f.hidden();
  await result;
});
it("accepts a beforeunload guard only when the tab is closing", () => {
  const accept = vi.fn(async () => {});
  const dialog = { type: () => "beforeunload", accept } as unknown as Dialog;
  expect(acceptClosingDialog(false, dialog)).toBe(false);
  expect(accept).not.toHaveBeenCalled();
  expect(acceptClosingDialog(true, dialog)).toBe(true);
  expect(accept).toHaveBeenCalledOnce();
});

effectIt.effect("marks a pending open for unload before letting the close complete", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread");
    const tabId = "tab";
    const key = tabKey(threadId, tabId);
    const opening = Promise.withResolvers<ServerTab>();
    const closedPending = new Set<string>();
    const beforeClose = makeBeforePreviewClose(
      new Map(),
      new Map([[key, { promise: opening.promise }]]),
      closedPending,
    );
    const closed = vi.fn();
    const closing = yield* beforeClose([
      {
        threadId,
        tabId,
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-11-18T00:00:00.000Z",
      },
    ]).pipe(
      Effect.tap(() => Effect.sync(closed)),
      Effect.forkChild({ startImmediately: true }),
    );
    expect(closedPending.has(key)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    opening.reject(new Error("The guest closed while opening"));
    yield* Fiber.join(closing);
    expect(closed).toHaveBeenCalledOnce();
  }),
);
