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

describe("client storage namespace migration", () => {
  it.each([
    ["goat:theme", "t3code:theme"], // goat-rename: legacy
    ["goat.preferences", "t3code.preferences"], // goat-rename: legacy
    ["goat:chatgpt-sharing-welcome:v1", "t3:chatgpt-sharing-welcome:v1"], // goat-rename: legacy
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
      ["t3code:theme", "old"],
    ]); // goat-rename: legacy
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
