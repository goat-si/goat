import { ThreadId } from "@goat/contracts";
import { isBlockedBrowserUrl } from "@goat/shared/preview";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

interface Tab {
  readonly threadId: string;
  readonly tabId: string;
  readonly closing: boolean;
  readonly page: { readonly url: () => string };
}
interface Identity {
  readonly threadId: string;
  readonly runId: string;
}

export const makeBlockedTabFence = Effect.fn("BlockedTabFence.make")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const entries = yield* Ref.make(new Map<string, Identity>());
  const tabRuns = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  const keyOf = (tab: Tab) => `${tab.threadId}\u0000${tab.tabId}`;
  const blocked = () =>
    new BrowserControlInterrupted("This browser host is blocked.", "blocked_url");
  const record = (key: string, identity: Identity) =>
    run(Ref.update(entries, (current) => new Map(current).set(key, identity)));
  const observe = (tab: Tab, url: string) => {
    const key = keyOf(tab);
    const previousRun = tabRuns.get(key);
    if (!previousRun) return;
    const runId = runSync(activity.currentRun(ThreadId.make(tab.threadId))) ?? previousRun;
    const prior = pending.get(key) ?? Promise.resolve();
    const check = prior.then(async () => {
      const current = await run(settings.getSettings);
      if (!tab.closing && isBlockedBrowserUrl(url, current.blockedBrowserHosts))
        await record(key, { threadId: tab.threadId, runId });
    });
    void check.catch(() => undefined);
    pending.set(key, check);
  };
  const assertUrl = async (url: string) => {
    const current = await run(settings.getSettings);
    if (isBlockedBrowserUrl(url, current.blockedBrowserHosts)) throw blocked();
  };
  const assertTab = async (tab: Tab, runId: string | undefined, url?: string) => {
    // This check fences later dispatches; input already sent before a navigation cannot be recalled.
    const key = keyOf(tab);
    const identity = runId ? { threadId: tab.threadId, runId } : undefined;
    for (;;) {
      const check = pending.get(key);
      await check;
      const entry = (await run(Ref.get(entries))).get(key);
      const current = await run(settings.getSettings);
      if (check !== pending.get(key)) continue;
      if (identity && entry?.threadId === identity.threadId && entry.runId === identity.runId)
        throw blocked();
      if (
        isBlockedBrowserUrl(tab.page.url(), current.blockedBrowserHosts) ||
        (url !== undefined && isBlockedBrowserUrl(url, current.blockedBrowserHosts))
      ) {
        if (identity) await record(key, identity);
        throw blocked();
      }
      if (runId) tabRuns.set(key, runId);
      return;
    }
  };
  const setRun = (threadId: string, tabId: string, runId: string) =>
    tabRuns.set(`${threadId}\u0000${tabId}`, runId);
  const drop = (threadId: string, tabId: string) => {
    const key = `${threadId}\u0000${tabId}`;
    tabRuns.delete(key);
    const check = pending.get(key);
    pending.delete(key);
    const clear = () =>
      run(
        Ref.update(entries, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      );
    void (check ?? Promise.resolve()).then(clear, clear);
  };
  return { assertTab, assertUrl, observe, setRun, drop };
});
