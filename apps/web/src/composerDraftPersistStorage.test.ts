import { EnvironmentId, ThreadId } from "@goat/contracts";
import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const STORAGE_KEY = "goat:composer-drafts:v1";
const alphaRef = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("alpha-new-thread"));
const betaRef = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("beta-new-thread"));

type DraftStoreModule = typeof import("./composerDraftStore");

/** Two module instances over one localStorage stand in for two tabs of the same origin. */
async function openTwoTabs(): Promise<{
  storage: ReturnType<typeof createMemoryStorage>;
  window: EventTarget;
  thisTab: DraftStoreModule;
  otherTab: DraftStoreModule;
}> {
  const storage = createMemoryStorage();
  const sharedWindow = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", sharedWindow);
  vi.resetModules();
  const thisTab = await import("./composerDraftStore");
  vi.resetModules();
  const otherTab = await import("./composerDraftStore");
  return { storage, window: sharedWindow, thisTab, otherTab };
}

/** Lets a debounced write fire and every write queued on the tabs' shared lock land. */
async function settleWrites(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
  await navigator.locks.request(`goat:storage-lock:${STORAGE_KEY}`, () => undefined);
}

function savedPrompts(storage: ReturnType<typeof createMemoryStorage>) {
  const saved = JSON.parse(storage.getItem(STORAGE_KEY) as string);
  return {
    alpha: saved.state.draftsByThreadKey[scopedThreadKey(alphaRef)]?.prompt,
    beta: saved.state.draftsByThreadKey[scopedThreadKey(betaRef)]?.prompt,
  };
}

async function withTabs(run: (tabs: Awaited<ReturnType<typeof openTwoTabs>>) => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run(await openTwoTabs());
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

describe("composer draft persistence across tabs", () => {
  // regression: upstream #35010 typing a draft in one tab erased drafts another tab saved after it loaded
  it("keeps a draft another tab saved after this tab loaded", () =>
    withTabs(async ({ storage, thisTab, otherTab }) => {
      otherTab.useComposerDraftStore.getState().setPrompt(betaRef, "beta draft");
      await settleWrites();
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "alpha draft");
      await settleWrites();

      expect(savedPrompts(storage)).toEqual({ alpha: "alpha draft", beta: "beta draft" });
    }));

  it("keeps this tab's draft when the other tab saves after it", () =>
    withTabs(async ({ storage, thisTab, otherTab }) => {
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "alpha draft");
      await settleWrites();
      otherTab.useComposerDraftStore.getState().setPrompt(betaRef, "beta draft");
      await settleWrites();

      expect(savedPrompts(storage)).toEqual({ alpha: "alpha draft", beta: "beta draft" });
    }));

  it("removes a draft this tab cleared without bringing back the other tab's copy", () =>
    withTabs(async ({ storage, thisTab, otherTab }) => {
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "alpha draft");
      await settleWrites();
      otherTab.useComposerDraftStore.getState().setPrompt(betaRef, "beta draft");
      await settleWrites();
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "");
      await settleWrites();

      expect(savedPrompts(storage)).toEqual({ alpha: undefined, beta: "beta draft" });
    }));

  it("writes the last draft at pagehide before the debounce fires", () =>
    withTabs(async ({ storage, window, thisTab }) => {
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "typed before closing");
      window.dispatchEvent(new Event("pagehide"));

      expect(savedPrompts(storage).alpha).toBe("typed before closing");
    }));

  it("writes the last draft at pagehide while its write waits for the lock", () =>
    withTabs(async ({ storage, window, thisTab }) => {
      let releaseLock!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = navigator.locks.request(`goat:storage-lock:${STORAGE_KEY}`, () => held);
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "typed before closing");
      await vi.advanceTimersByTimeAsync(300);
      expect(storage.getItem(STORAGE_KEY)).toBeNull();

      window.dispatchEvent(new Event("pagehide"));
      expect(savedPrompts(storage).alpha).toBe("typed before closing");

      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "typed after pagehide");
      window.dispatchEvent(new Event("pagehide"));
      releaseLock();
      await holder;
      await settleWrites();
      expect(savedPrompts(storage).alpha).toBe("typed after pagehide");
    }));
});
