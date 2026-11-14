// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Playwright close callbacks run outside Effect.
import * as NodeCrypto from "node:crypto";
import type { Dialog, Page } from "playwright-core";
import { constVoid } from "effect/Function";

const PAGE_CLOSE_GRACE_MS = 5_000;

export const closeServerPage = (page: Page, isolated: boolean, dialog: boolean) => {
  const closed = page.isClosed()
    ? Promise.resolve()
    : new Promise<void>((resolve) => page.once("close", () => resolve()));
  const forceClose = setTimeout(() => void page.close().catch(constVoid), PAGE_CLOSE_GRACE_MS);
  void closed.then(() => clearTimeout(forceClose));
  void page
    .close({ runBeforeUnload: !dialog })
    .catch(() => page.close())
    .catch(constVoid);
  if (isolated) void closed.then(() => page.context().close()).catch(constVoid);
};

export const unloadDesktopPage = async (page: Page) => {
  const unloaded = Promise.withResolvers<void>();
  const timeout = setTimeout(unloaded.resolve, PAGE_CLOSE_GRACE_MS);
  const binding = `__goatPreviewUnloaded${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  void (async () => {
    await page.exposeFunction(binding, unloaded.resolve);
    await page.evaluate((name) => {
      const target = globalThis as unknown as {
        addEventListener: (type: string, listener: () => void) => void;
      };
      target.addEventListener("pagehide", () =>
        Reflect.apply(Reflect.get(target, name), target, []),
      );
    }, binding);
    await page.close({ runBeforeUnload: true });
  })().catch(unloaded.resolve);
  await unloaded.promise;
  clearTimeout(timeout);
};

export const acceptClosingDialog = (closing: boolean, dialog: Dialog) => {
  if (!closing || dialog.type() !== "beforeunload") return false;
  void dialog.accept().catch(constVoid);
  return true;
};

export const unloadDesktopTab = async (tab: { closing: boolean; page: Page }) => {
  tab.closing = true;
  await unloadDesktopPage(tab.page);
};
