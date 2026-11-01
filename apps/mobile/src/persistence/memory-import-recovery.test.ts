import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MemorySpaceId, MemoryOperationId } from "@goat/contracts";
import {
  MEMORY_IMPORT_RECOVERY_TTL_MS,
  memoryImportRecoveryKey,
} from "@goat/client-runtime/memory-import-recovery";
import * as Effect from "effect/Effect";
import { createMobileMemoryImportRecovery, memoryImportSecureKey } from "./memory-import-recovery";
vi.mock("./namespaced-secure-store", () => ({ secureStore: {} }));
const destination = {
  environmentId: EnvironmentId.make("synthetic-owner"),
  memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
};
const operationId = MemoryOperationId.make("00000000-0000-4000-8000-000000000002");
function fixture() {
  let now = 1000;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => Effect.succeed(values.get(key) ?? null),
    setItem: (key: string, value: string) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key: string) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  };
  return {
    values,
    storage,
    setNow: (value: number) => {
      now = value;
    },
    create: () => createMobileMemoryImportRecovery(storage, () => now),
  };
}
describe("native secure import recovery", () => {
  it("persists only a versioned body-free handle and loads it on a fresh adapter", async () => {
    const f = fixture();
    await f.create().save(destination, operationId);
    const key = memoryImportSecureKey(memoryImportRecoveryKey(destination));
    expect(key).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(JSON.parse(f.values.get(key)!)).toEqual({
      version: 1,
      handle: {
        ...destination,
        operationId,
        savedAt: 1000,
        expiresAt: 1000 + MEMORY_IMPORT_RECOVERY_TTL_MS,
      },
    });
    expect((await f.create().load(destination))?.operationId).toBe(operationId);
    await f.create().clear(destination);
    expect(await f.create().load(destination)).toBeNull();
  });
  it("removes malformed, excessive and expired values without extending the TTL", async () => {
    const f = fixture();
    const store = f.create();
    const key = memoryImportSecureKey(memoryImportRecoveryKey(destination));
    f.values.set(key, '{"version":99,"body":"must be removed"}');
    expect(await store.load(destination)).toBeNull();
    expect(f.values.size).toBe(0);
    await store.save(destination, operationId);
    const value = f.values.get(key)!;
    f.setNow(1001);
    await store.load(destination);
    expect(f.values.get(key)).toBe(value);
    f.setNow(1000 + MEMORY_IMPORT_RECOVERY_TTL_MS);
    expect(await store.load(destination)).toBeNull();
    expect(f.values.size).toBe(0);
  });
  it("does not collide across destinations and serializes unresolved writes", async () => {
    const f = fixture();
    const store = f.create();
    const other = { ...destination, environmentId: EnvironmentId.make("other") };
    await store.save(destination, operationId);
    await expect(store.save(destination, operationId)).rejects.toThrow();
    await store.save(other, operationId);
    await store.clear(destination);
    expect((await store.load(other))?.operationId).toBe(operationId);
  });
  it("propagates secure storage failure instead of pretending a handle was saved", async () => {
    const f = fixture();
    const store = createMobileMemoryImportRecovery({
      ...f.storage,
      setItem: () => Effect.die(new Error("synthetic storage failed")),
    });
    await expect(store.save(destination, operationId)).rejects.toThrow();
    expect(f.values.size).toBe(0);
  });
});
