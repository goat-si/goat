import type { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  GLOBAL_AGENT_STORAGE_KEY,
  isGlobalAgentRef,
  mergePersistedGlobalAgent,
  migratePersistedGlobalAgent,
  selectGlobalAgentMode,
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
  useGlobalAgentStore.setState({ ref: null, botRef: null, mode: null });
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
    expect(migratePersistedGlobalAgent({ ref: REF }, 0)).toEqual({
      ref: REF,
      botRef: null,
      mode: null,
    });
  });
  it("migrate drops an invalid ref", () => {
    expect(migratePersistedGlobalAgent({ ref: 1 }, 0)).toEqual({
      ref: null,
      botRef: null,
      mode: null,
    });
  });
  it("keeps either chosen mode and reads anything else as unchosen", () => {
    const current = useGlobalAgentStore.getState();
    expect(mergePersistedGlobalAgent({ mode: "thread" }, current).mode).toBe("thread");
    expect(mergePersistedGlobalAgent({ mode: "bot" }, current).mode).toBe("bot");
    expect(mergePersistedGlobalAgent({ mode: "other" }, current).mode).toBeNull();
  });
  it("merge drops an invalid ref and keeps actions", () => {
    const current = useGlobalAgentStore.getState();
    const merged = mergePersistedGlobalAgent({ ref: { ...REF, draftId: "" } }, current);
    expect(merged.ref).toBeNull();
    expect(merged.setRef).toBe(current.setRef);
  });
  it("same-version hydration drops an invalid ref (merge path)", async () => {
    expect(await hydrateFrom({ state: { ref: { ...REF, threadId: "" } }, version: 3 })).toBeNull();
  });
  it("same-version hydration keeps a valid ref", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 3 })).toEqual(REF);
  });
  it("older-version hydration keeps a valid ref (migrate path)", async () => {
    expect(await hydrateFrom({ state: { ref: REF }, version: 0 })).toEqual(REF);
  });
});

describe("logo mode", () => {
  it("opens the global agent's thread until someone picks a mode", async () => {
    expect(selectGlobalAgentMode(useGlobalAgentStore.getState())).toBe("thread");
    await hydrateFrom({ state: { ref: REF }, version: 3 });
    expect(selectGlobalAgentMode(useGlobalAgentStore.getState())).toBe("thread");
  });
  it("moves clients that only saved the old bot default to thread mode", async () => {
    await hydrateFrom({ state: { ref: REF, mode: "bot" }, version: 2 });
    expect(selectGlobalAgentMode(useGlobalAgentStore.getState())).toBe("thread");
  });
  it("keeps thread mode chosen before the default changed", async () => {
    await hydrateFrom({ state: { ref: REF, mode: "thread" }, version: 2 });
    expect(useGlobalAgentStore.getState().mode).toBe("thread");
  });
  it("remembers GOAT Bot once someone picks it", async () => {
    await hydrateFrom({ state: { ref: REF, botRef: null, mode: "bot" }, version: 3 });
    expect(selectGlobalAgentMode(useGlobalAgentStore.getState())).toBe("bot");
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
