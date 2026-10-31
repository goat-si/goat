import { ThreadId } from "@goat/contracts";
import { isBlockedBrowserUrl } from "@goat/shared/preview";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";
import type { DispatchGate } from "./ServerBrowserPage.ts";

interface Tab {
  readonly threadId: string;
  readonly tabId: string;
  readonly closing: boolean;
  readonly page: { readonly frames: () => ReadonlyArray<{ readonly url: () => string }> };
  readonly control?: { readonly cutBlockedUrl: () => void };
}
interface Identity {
  readonly threadId: string;
  readonly runId: string;
}
export interface BlockedTabRun {
  readonly runId: string;
  readonly token: object;
}

export const checkOpenBlocked = async (check: () => Promise<void>, sent: boolean) => {
  try {
    await check();
  } catch (cause) {
    if (sent && cause instanceof BrowserControlInterrupted && cause.reason === "blocked_url")
      throw new BrowserControlInterrupted(cause.message, cause.reason, false);
    throw cause;
  }
};

export const makeBlockedTabFence = Effect.fn("BlockedTabFence.make")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const entries = new Map<string, Identity>();
  const pending = new Map<string, { runId: string; check: Promise<void> }>();
  const tokens = new Map<string, object>();
  const keyOf = (tab: Tab) => `${tab.threadId}\u0000${tab.tabId}`;
  const entryKey = (key: string, runId: string) => `${key}\u0000${runId}`;
  const runKey = (threadId: string, runId: string) => `${threadId}\u0000${runId}`;
  const active = (threadId: string, runId: string) =>
    runSync(activity.isRunActive(ThreadId.make(threadId), runId));
  const token = (threadId: string, runId: string) => {
    if (!active(threadId, runId)) return undefined;
    const key = runKey(threadId, runId);
    const value = tokens.get(key) ?? {};
    tokens.set(key, value);
    return value;
  };
  yield* activity.onRunEnd((threadId, runId) => {
    tokens.delete(runKey(threadId, runId));
    const prefix = `${threadId}\u0000`;
    for (const [key, value] of entries)
      if (key.startsWith(prefix) && value.runId === runId) entries.delete(key);
    for (const [key, value] of pending)
      if (key.startsWith(prefix) && value.runId === runId) pending.delete(key);
  });
  const blocked = () =>
    new BrowserControlInterrupted("This browser host is blocked.", "blocked_url");
  const capture = (threadId: string): BlockedTabRun | undefined => {
    const runId = runSync(activity.currentRun(ThreadId.make(threadId)));
    if (!runId) return undefined;
    const value = token(threadId, runId);
    return value ? { runId, token: value } : undefined;
  };
  const observe = (tab: Tab, url: string, observedRun?: BlockedTabRun) => {
    const key = keyOf(tab);
    const observed = observedRun ?? capture(tab.threadId);
    if (!observed) return;
    const { runId, token: version } = observed;
    if (
      !tab.closing &&
      settings.blockedBrowserHostsSnapshot &&
      isBlockedBrowserUrl(url, runSync(settings.blockedBrowserHostsSnapshot)) &&
      !entries.has(entryKey(key, runId)) &&
      version === tokens.get(runKey(tab.threadId, runId)) &&
      active(tab.threadId, runId)
    ) {
      entries.set(entryKey(key, runId), { threadId: tab.threadId, runId });
      tab.control?.cutBlockedUrl();
    }
    const prior = pending.get(key)?.check ?? Promise.resolve();
    const check = prior.then(async () => {
      const current = await run(settings.getSettings);
      if (
        !tab.closing &&
        version !== undefined &&
        version === tokens.get(runKey(tab.threadId, runId)) &&
        active(tab.threadId, runId) &&
        !entries.has(entryKey(key, runId)) &&
        isBlockedBrowserUrl(url, current.blockedBrowserHosts)
      ) {
        entries.set(entryKey(key, runId), { threadId: tab.threadId, runId });
        tab.control?.cutBlockedUrl();
      }
    });
    void check.catch(() => undefined);
    pending.set(key, { runId, check });
    return check;
  };
  const assertUrl = async (url: string) => {
    const current = await run(settings.getSettings);
    if (isBlockedBrowserUrl(url, current.blockedBrowserHosts)) throw blocked();
  };
  const assertTab = async (tab: Tab, runId: string | undefined, url?: string) => {
    const key = keyOf(tab);
    const version = runId ? token(tab.threadId, runId) : undefined;
    for (;;) {
      const check = pending.get(key);
      await check?.check;
      const entry = runId ? entries.get(entryKey(key, runId)) : undefined;
      const current = await run(settings.getSettings);
      if (check !== pending.get(key)) continue;
      if (runId && entry?.threadId === tab.threadId && entry.runId === runId) {
        tab.control?.cutBlockedUrl();
        throw blocked();
      }
      if (
        tab.page
          .frames()
          .some((frame) => isBlockedBrowserUrl(frame.url(), current.blockedBrowserHosts)) ||
        (url !== undefined && isBlockedBrowserUrl(url, current.blockedBrowserHosts))
      ) {
        if (
          runId &&
          version !== undefined &&
          version === tokens.get(runKey(tab.threadId, runId)) &&
          active(tab.threadId, runId)
        )
          entries.set(entryKey(key, runId), { threadId: tab.threadId, runId });
        tab.control?.cutBlockedUrl();
        throw blocked();
      }
      return;
    }
  };
  const isFenced = (tab: Tab, runId: string | undefined) =>
    runId !== undefined && entries.has(entryKey(keyOf(tab), runId));
  const blockedFrame = (tab: Tab, runId: string | undefined, destination?: string) => {
    if (!settings.blockedBrowserHostsSnapshot) throw new Error("Blocked-host snapshot unavailable");
    const hosts = runSync(settings.blockedBrowserHostsSnapshot);
    if (
      !tab.page.frames().some((frame) => isBlockedBrowserUrl(frame.url(), hosts)) &&
      !(destination && isBlockedBrowserUrl(destination, hosts))
    )
      return false;
    if (runId && active(tab.threadId, runId))
      entries.set(entryKey(keyOf(tab), runId), { threadId: tab.threadId, runId });
    tab.control?.cutBlockedUrl();
    return true;
  };
  const gate = (tab: Tab, runId: string | undefined, base: DispatchGate): DispatchGate => {
    let passed = false;
    const check = async () => {
      try {
        await assertTab(tab, runId);
        await base.check?.();
      } catch (cause) {
        if (passed && cause instanceof BrowserControlInterrupted && cause.beforeInput)
          throw new BrowserControlInterrupted(cause.message, cause.reason, false);
        throw cause;
      }
    };
    return Object.assign(
      async () => {
        await check();
        await base();
        passed = true;
      },
      { check },
      base.linger ? { linger: base.linger } : {},
    );
  };
  const drop = (threadId: string, tabId: string) => {
    const key = `${threadId}\u0000${tabId}`;
    pending.delete(key);
    for (const entry of entries.keys()) if (entry.startsWith(`${key}\u0000`)) entries.delete(entry);
  };
  return { assertTab, assertUrl, capture, observe, drop, gate, isFenced, blockedFrame };
});
