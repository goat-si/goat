// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Playwright close callbacks run outside Effect.
import * as NodeCrypto from "node:crypto";
import type { PreviewSessionSnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { Dialog, Page } from "playwright-core";
import { constVoid } from "effect/Function";

import { tabKey } from "./ServerBrowserPointer.ts";
import type { ServerTab } from "./ServerBrowserTab.ts";

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

export const makeBeforePreviewClose = (
  tabs: ReadonlyMap<string, ServerTab>,
  pendingTabs: ReadonlyMap<string, { readonly promise?: Promise<ServerTab> }>,
  closedPendingTabs: Set<string>,
) => {
  const unloading = new WeakMap<ServerTab, Promise<void>>();
  return Effect.fn("ServerBrowser.beforePreviewClose")(function* (
    snapshots: ReadonlyArray<PreviewSessionSnapshot>,
  ) {
    yield* Effect.promise(() =>
      Promise.all(
        snapshots.map((snapshot) => {
          const key = tabKey(snapshot.threadId, snapshot.tabId);
          const tab = tabs.get(key);
          if (tab) {
            const existing = unloading.get(tab);
            if (existing) return existing;
            void tab.control.close().catch(constVoid);
            if (!tab.desktop || tab.dialog !== null) return;
            const pending = unloadDesktopTab(tab);
            unloading.set(tab, pending);
            return pending;
          }
          const opening = pendingTabs.get(key);
          if (!opening) return;
          closedPendingTabs.add(key);
          if (!opening.promise) return;
          const settled = Promise.withResolvers<void>();
          const timer = setTimeout(settled.resolve, PAGE_CLOSE_GRACE_MS);
          void opening.promise.then(settled.resolve, settled.resolve);
          return settled.promise.finally(() => clearTimeout(timer));
        }),
      ),
    );
  });
};
