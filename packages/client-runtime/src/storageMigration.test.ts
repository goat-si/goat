import { describe, expect, it, vi } from "vite-plus/test";
import { migratingStorage, REMOVED_STORAGE_VALUE } from "./storageMigration.ts";

function memory(initial: [string, string][] = []) {
  const values = new Map(initial);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

const quotaError = () => new DOMException("storage quota exceeded", "QuotaExceededError");

describe("client storage namespace migration", () => {
  it.each([
    ["goat:theme", "t3code:theme"], // goat-rename: legacy
    ["goat.preferences", "t3code.preferences"], // goat-rename: legacy
    ["goat:chatgpt-sharing-welcome:v1", "t3:chatgpt-sharing-welcome:v1"], // goat-rename: legacy
    ["goat.backgroundActivity.clientId", "t3.backgroundActivity.clientId"], // goat-rename: legacy
  ])("adopts %s once and retains its old value", (key, legacy) => {
    const base = memory([[legacy, "old"]]);
    const storage = migratingStorage(base);
    expect(storage.getItem(key)).toBe("old");
    expect(base.values.get(key)).toBe("old");
    storage.setItem(key, "new");
    base.getItem.mockClear();
    expect(storage.getItem(key)).toBe("new");
    expect(base.getItem.mock.calls).toEqual([[key]]);
    expect(base.values.get(legacy)).toBe("old");
    expect(migratingStorage(base)).toBe(storage);
    expect(migratingStorage(storage)).toBe(storage);
  });

  it("prefers an empty new value and leaves unrelated keys alone", () => {
    const base = memory([
      ["goat:theme", ""],
      ["t3code:theme", "old"], // goat-rename: legacy
    ]);
    const storage = migratingStorage(base);
    expect(storage.getItem("goat:theme")).toBe("");
    expect(storage.getItem("other")).toBeNull();
    storage.setItem("other", "value");
    storage.removeItem("other");
    expect(base.values.has("other")).toBe(false);
  });

  it("clears a migrated value across reloads without deleting the legacy key", () => {
    const base = memory([["t3code:theme", "old"]]); // goat-rename: legacy
    const storage = migratingStorage(base);
    storage.removeItem("goat:theme");
    expect(base.values.get("goat:theme")).toBe(REMOVED_STORAGE_VALUE);
    expect(migratingStorage({ ...base }).getItem("goat:theme")).toBeNull();
    expect(base.values.get("t3code:theme")).toBe("old"); // goat-rename: legacy
    expect(base.removeItem).not.toHaveBeenCalled();
    storage.setItem("goat:theme", "next");
    expect(storage.getItem("goat:theme")).toBe("next");
  });

  it("keeps legacy reads available when adoption fails and retries", () => {
    const base = memory([["t3code:theme", "old"]]); // goat-rename: legacy
    base.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    const storage = migratingStorage(base);
    expect(storage.getItem("goat:theme")).toBe("old");
    expect(base.values.has("goat:theme")).toBe(false);
    expect(storage.getItem("goat:theme")).toBe("old");
    expect(base.values.get("goat:theme")).toBe("old");
  });

  it("migrates async secure storage and prevents cleared credentials from returning", async () => {
    const base = memory([["t3code.cloud.dpop-proof-key", "private-key"]]); // goat-rename: legacy
    const storage = migratingStorage({
      getItem: async (key: string) => base.getItem(key),
      setItem: async (key: string, value: string) => {
        base.setItem(key, value);
      },
      removeItem: async (key: string) => {
        base.removeItem(key);
      },
    });
    expect(await storage.getItem("goat.cloud.dpop-proof-key")).toBe("private-key");
    await storage.removeItem("goat.cloud.dpop-proof-key");
    expect(await storage.getItem("goat.cloud.dpop-proof-key")).toBeNull();
    expect(base.values.get("t3code.cloud.dpop-proof-key")).toBe("private-key"); // goat-rename: legacy
    expect(base.removeItem).not.toHaveBeenCalled();
  });

  it("propagates read failures and tolerates failed async adoption", async () => {
    const base = memory([["t3code:theme", "old"]]); // goat-rename: legacy
    const storage = migratingStorage({
      getItem: async (key: string) => base.getItem(key),
      setItem: async () => {
        throw new Error("read-only");
      },
      removeItem: async () => {},
    });
    expect(await storage.getItem("goat:theme")).toBe("old");
    base.getItem.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    await expect(storage.getItem("goat:theme")).rejects.toThrow("blocked");
  });
});

describe("migration under pressure", () => {
  it("drops the retained legacy copy when the current value no longer fits", () => {
    const base = memory([["t3code:composer-drafts:v1", "large legacy draft"]]); // goat-rename: legacy
    let quota = 1;
    base.setItem.mockImplementation((key: string, value: string) => {
      if (base.values.size >= quota && !base.values.has(key)) throw quotaError();
      base.values.set(key, value);
    });
    const storage = migratingStorage(base);
    // Adoption cannot duplicate the legacy draft, but reading still works.
    expect(storage.getItem("goat:composer-drafts:v1")).toBe("large legacy draft");
    storage.setItem("goat:composer-drafts:v1", "edited draft");
    expect(base.values.get("goat:composer-drafts:v1")).toBe("edited draft");
    expect(base.values.has("t3code:composer-drafts:v1")).toBe(false); // goat-rename: legacy
    quota = 0;
    expect(() => storage.setItem("goat:other", "x")).toThrow("storage quota exceeded");
  });

  it("keeps the legacy copy when a write fails for any reason other than quota", () => {
    const base = memory([["t3code:theme", "old"]]); // goat-rename: legacy
    const cause = new Error("storage disabled");
    base.setItem.mockImplementation(() => {
      throw cause;
    });
    const storage = migratingStorage(base);
    expect(() => storage.setItem("goat:theme", "dark")).toThrow(cause);
    expect(() => storage.removeItem("goat:theme")).toThrow(cause);
    expect(base.values.get("t3code:theme")).toBe("old"); // goat-rename: legacy
    expect(base.removeItem).not.toHaveBeenCalled();
  });

  it("clears a legacy-only value when the removal marker does not fit", () => {
    const base = memory([["t3code:composer-drafts:v1", "draft"]]); // goat-rename: legacy
    base.setItem.mockImplementation(() => {
      throw quotaError();
    });
    const storage = migratingStorage(base);
    expect(storage.getItem("goat:composer-drafts:v1")).toBe("draft");
    storage.removeItem("goat:composer-drafts:v1");
    expect(storage.getItem("goat:composer-drafts:v1")).toBeNull();
    expect(base.values.size).toBe(0);
  });

  it("clears a current value whose legacy copy is already gone when the marker does not fit", async () => {
    const base = memory([["goat:composer-drafts:v1", "draft"]]);
    base.setItem.mockImplementation(() => {
      throw quotaError();
    });
    migratingStorage(base).removeItem("goat:composer-drafts:v1");
    expect(base.values.size).toBe(0);

    const values = new Map([["goat.cloud.relay-token", "token"]]);
    const asyncStorage = migratingStorage({
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async () => {
        throw quotaError();
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    });
    await asyncStorage.removeItem("goat.cloud.relay-token");
    expect(await asyncStorage.getItem("goat.cloud.relay-token")).toBeNull();
    expect(values.size).toBe(0);
  });

  it("makes room the same way when an async backend rejects over quota", async () => {
    const values = new Map([["t3code.cloud.relay-token", "legacy token"]]); // goat-rename: legacy
    const storage = migratingStorage({
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        if (values.size >= 1 && !values.has(key)) throw quotaError();
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    });
    await storage.setItem("goat.cloud.relay-token", "new token");
    expect(values.get("goat.cloud.relay-token")).toBe("new token");
    expect(values.has("t3code.cloud.relay-token")).toBe(false); // goat-rename: legacy
  });

  it("lets a clear that starts after a pending read win", async () => {
    const values = new Map([["t3code.cloud.relay-token", "legacy token"]]); // goat-rename: legacy
    let releaseRead: () => void = () => undefined;
    const slowRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const base = {
      getItem: async (key: string) => {
        // The backend answers with the value it saw when the read started.
        const value = values.get(key) ?? null;
        if (key === "goat.cloud.relay-token") await slowRead;
        return value;
      },
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const storage = migratingStorage(base);
    const read = storage.getItem("goat.cloud.relay-token");
    const clear = storage.removeItem("goat.cloud.relay-token");
    releaseRead();
    expect(await read).toBe("legacy token");
    await clear;
    expect(await storage.getItem("goat.cloud.relay-token")).toBeNull();
  });
});
