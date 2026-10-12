import type { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  GLOBAL_AGENT_STORAGE_KEY,
  isGlobalAgentRef,
  mergePersistedGlobalAgent,
  migratePersistedGlobalAgent,
  useGlobalAgentStore,
} from "./globalAgentStore";
import { createMemoryStorage } from "./lib/storage";

const REF = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
  draftId: "draft-1" as DraftId,
};

async function hydrateFrom(raw: unknown) {
  const storage = createMemoryStorage();
  storage.setItem(GLOBAL_AGENT_STORAGE_KEY, JSON.stringify(raw));
  useGlobalAgentStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  await useGlobalAgentStore.persist.rehydrate();
  return useGlobalAgentStore.getState().ref;
}

beforeEach(() => {
  useGlobalAgentStore.setState({ ref: null, botRef: null, mode: "bot" });
});

describe("isGlobalAgentRef", () => {
  it("accepts a complete ref", () => {
    expect(isGlobalAgentRef(REF)).toBe(true);
  });
  it("rejects an empty field", () => {
    expect(isGlobalAgentRef({ ...REF, draftId: "" })).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(isGlobalAgentRef(null)).toBe(false);
    expect(isGlobalAgentRef(42)).toBe(false);
  });
});

describe("persisted global agent", () => {
  it("migrate keeps a valid ref", () => {
    expect(migratePersistedGlobalAgent({ ref: REF })).toEqual({
      ref: REF,
      botRef: null,
      mode: "bot",
    });
  });
  it("migrate drops an invalid ref", () => {
    expect(migratePersistedGlobalAgent({ ref: 1 })).toEqual({
      ref: null,
      botRef: null,
      mode: "bot",
    });
  });
  it("keeps the chosen thread mode and reads anything else as the bot", () => {
    const current = useGlobalAgentStore.getState();
    expect(mergePersistedGlobalAgent({ mode: "thread" }, current).mode).toBe("thread");
    expect(mergePersistedGlobalAgent({ mode: "other" }, current).mode).toBe("bot");
  });
  it("merge drops an invalid ref and keeps actions", () => {
    const current = useGlobalAgentStore.getState();
    const merged = mergePersistedGlobalAgent({ ref: { ...REF, draftId: "" } }, current);
    expect(merged.ref).toBeNull();
    expect(merged.setRef).toBe(current.setRef);
  });
  it("same-version hydration drops an invalid ref (merge path)", async () => {
    expect(await hydrateFrom({ state: { ref: { ...REF, threadId: "" } }, version: 2 })).toBeNull();
  });
  it("same-version hydration keeps a valid ref", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 2 })).toEqual(REF);
  });
  it("older-version hydration keeps a valid ref (migrate path)", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 0 })).toEqual(REF);
  });
});

describe("clearIfThread", () => {
  it("clears the matching thread", () => {
    useGlobalAgentStore.setState({ ref: REF });
    useGlobalAgentStore
      .getState()
      .clearIfThread({ environmentId: REF.environmentId, threadId: REF.threadId });
    expect(useGlobalAgentStore.getState().ref).toBeNull();
  });
  it("keeps the ref for another thread", () => {
    useGlobalAgentStore.setState({ ref: REF });
    useGlobalAgentStore
      .getState()
      .clearIfThread({ environmentId: REF.environmentId, threadId: "thread-2" as ThreadId });
    expect(useGlobalAgentStore.getState().ref).toEqual(REF);
  });
});

describe("GOAT Bot ref", () => {
  const BOT = {
    environmentId: REF.environmentId,
    projectId: "scratch" as ProjectId,
    threadId: "bot" as ThreadId,
  };

  it("starts empty when upgrading from before GOAT Bot", async () => {
    await hydrateFrom({ state: { ref: REF, botRef: BOT }, version: 1 });
    expect(useGlobalAgentStore.getState().botRef).toBeNull();
  });
  it("keeps a valid bot ref and drops a broken one on same-version hydration", async () => {
    await hydrateFrom({ state: { ref: REF, botRef: BOT }, version: 2 });
    expect(useGlobalAgentStore.getState().botRef).toEqual(BOT);
    await hydrateFrom({ state: { ref: REF, botRef: { ...BOT, projectId: "" } }, version: 2 });
    expect(useGlobalAgentStore.getState().botRef).toBeNull();
  });
  it("keeps marking the bot thread after it is archived here", () => {
    useGlobalAgentStore.setState({ ref: REF, botRef: BOT });
    useGlobalAgentStore
      .getState()
      .clearIfThread({ environmentId: BOT.environmentId, threadId: BOT.threadId });
    expect(useGlobalAgentStore.getState().botRef).toEqual(BOT);
    expect(useGlobalAgentStore.getState().ref).toEqual(REF);
  });
});
