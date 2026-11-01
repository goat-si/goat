import { constVoid } from "effect/Function";
import type { CDPSession, Page } from "playwright-core";
import { watchOpenings } from "./agentTabState.ts";
import { watchPrivateMode } from "./PreviewPrivateMode.ts";

export const startBrowserWatchers = (
  tab: Parameters<typeof watchOpenings>[1] & {
    readonly page: Page;
    readonly cdp: CDPSession;
    readonly control: { readonly setPrivate: (on: boolean) => void };
  },
  now: () => number,
  signal?: AbortSignal,
) => {
  const openings = watchOpenings(tab.cdp, tab, now, signal);
  const privateMode = watchPrivateMode(tab.page, (on) => tab.control.setPrivate(on), signal);
  if (signal)
    return Promise.allSettled([openings, privateMode]).then(() => signal.throwIfAborted());
  void openings.catch(constVoid);
  void privateMode.catch(constVoid);
  return Promise.resolve();
};

export const makeContextPreparer = () => {
  const prepared = new WeakSet<import("playwright-core").BrowserContext>();
  return async (context: import("playwright-core").BrowserContext) => {
    if (prepared.has(context)) return;
    prepared.add(context);
    await context.grantPermissions(["clipboard-write"]);
  };
};
