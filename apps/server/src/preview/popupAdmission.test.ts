import { it, expect, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { closePopupOnAbort, closeUnadoptedPopup } from "./popupAdmission.ts";

it("closes an unadopted popup when an already-aborted CDP close fails", async () => {
  let closed = false;
  const page = {
    isClosed: () => closed,
    close: vi.fn(async () => {
      closed = true;
    }),
  } as unknown as Page;
  const controller = new AbortController();
  controller.abort();
  const handled = Promise.withResolvers<void>();
  const close = vi.fn(() => {
    const closing = Promise.reject(new Error("CDP close failed"));
    const original = closing.catch.bind(closing);
    closing.catch = (onRejected) => original(onRejected).finally(() => handled.resolve());
    return closing;
  });
  const releaseOrigin = vi.fn();
  const release = closePopupOnAbort(
    controller.signal,
    releaseOrigin,
    close,
    closeUnadoptedPopup(page, () => undefined),
  );
  await handled.promise;
  expect(close).toHaveBeenCalledOnce();
  expect(closed).toBe(true);
  release();
  expect(releaseOrigin).toHaveBeenCalledOnce();
});
