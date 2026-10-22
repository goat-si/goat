import { stubGlobal } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import * as M from "@goat/contracts";
import { createMemoryImportWorkflow } from "@goat/client-runtime/memory-import-workflow";
import {
  memoryImportRecoveryKey,
  MEMORY_IMPORT_RECOVERY_TTL_MS,
} from "@goat/client-runtime/memory-import-recovery";
import {
  createMemoryImportAdmission,
  memoryImportGenerationKey,
  removeMemoryImportDestination,
  memoryImportRecoveryStorage,
} from "./memoryImportRecoveryStorage";
import { memorySyncFixture } from "../test/memorySyncFixture";
import { memoryImportTestLocks } from "../test/memoryImportLocks";
function setup() {
  const scope = new DisposableStack();
  scope.use(stubGlobal("navigator", { locks: memoryImportTestLocks() }));
  localStorage.clear();
  scope.defer(() => localStorage.clear());
  return scope;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const destination = {
  environmentId: M.EnvironmentId.make("device"),
  memorySpaceId: M.MemorySpaceId.make(uuid(1)),
};
const sourceId = M.MemoryImportSourceId.make(uuid(3));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  count = 65,
  store = memoryImportRecoveryStorage(localStorage),
  capturePreview = async () => {},
) {
  const calls: M.MemoryImportProviderInput[] = [];
  const selections = Array.from({ length: count }, (_, index) => ({
    sourceItemKey: `item-${index}`,
    sourceFingerprint: "a".repeat(64),
    scope: { kind: "user" as const },
  }));
  let nextId = 10;
  let allowed = true;
  const respond = (input: M.MemoryImportProviderInput): M.MemoryImportProviderResult =>
    input.action === "discover"
      ? { action: "discover", sources: [] }
      : input.action === "preview"
        ? {
            action: "preview",
            sourceId,
            sessionId: "preview-session",
            items: selections.map((item) => ({ ...item, byteCount: 1, mappingRequired: false })),
          }
        : {
            action: input.action,
            receipt: {
              operationId: input.operationId,
              sourceId,
              sessionId: "preview-session",
              sessionNewItems: 1,
              sessionBodyBytes: 1,
              state: "completed",
              items: [],
              remaining: 0,
            },
            syncStatus: memorySyncFixture,
          };
  let request = async (input: M.MemoryImportProviderInput) => respond(input);
  const create = () =>
    createMemoryImportWorkflow({
      fence: { ...destination, session: `session-${nextId++}` },
      recovery: store,
      canImport: () => allowed,
      operationId: () => M.MemoryOperationId.make(uuid(nextId++)),
      request: async (_, input) => {
        calls.push(input);
        return request(input);
      },
    });
  const workflow = create();
  return {
    store,
    calls,
    selections,
    respond,
    create,
    workflow,
    setRequest: (next: typeof request) => {
      request = next;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    ready: async () => {
      await capturePreview();
      await workflow.preview(sourceId);
      workflow.select(selections);
    },
  };
}
it("shares a store across mounts and persists only the strict handle", async () => {
  using _scope = setup();
  const f = fixture(1);
  expect(memoryImportRecoveryStorage(localStorage)).toBe(f.store);
  await f.ready();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
      const raw = localStorage.getItem(memoryImportRecoveryKey(destination))!;
      expect(raw).not.toContain("sourceItemKey");
      expect(raw).not.toContain("preview-session");
      throw new Error("response lost");
    }
    return f.respond(input);
  });
  await f.workflow.apply();
  const saved = await f.store.load(destination);
  expect(saved).not.toBeNull();
  f.calls.length = 0;
  f.setRequest(async (input) => f.respond(input));
  await f.create().recover();
  expect(f.calls).toEqual([
    { action: "status", memorySpaceId: destination.memorySpaceId, operationId: saved!.operationId },
  ]);
  expect(await f.store.load(destination)).toBeNull();
});
it("blocks apply until storage succeeds and never admits after storage failure", async () => {
  using _scope = setup();
  const f = fixture(1);
  await f.ready();
  const saved = deferred<void>();
  const release = deferred<void>();
  const original = Storage.prototype.setItem;
  using setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    original.call(this, key, value);
  });
  const save = f.store.save.bind(f.store);
  using _save = vi.spyOn(f.store, "save").mockImplementation(async (...args) => {
    saved.resolve();
    await release.promise;
    return save(...args);
  });
  const applying = f.workflow.apply();
  await saved.promise;
  expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(0);
  release.resolve();
  await applying;
  expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
  const next = fixture(1);
  await next.ready();
  setItem.mockImplementation(() => {
    throw new Error("quota");
  });
  await next.workflow.apply();
  expect(next.workflow.getSnapshot().phase).toBe("save_failed");
  expect(next.calls.filter((input) => input.action === "apply")).toHaveLength(0);
});
it("Stop allows the admitted chunk to settle and stops subsequent chunks", async () => {
  using _scope = setup();
  const f = fixture();
  await f.ready();
  const admitted = deferred<void>();
  const reply = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await reply.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.workflow.stop();
  reply.resolve();
  await applying;
  expect(
    f.calls.filter((input) => input.action === "apply").map((input) => input.items.length),
  ).toEqual([32]);
  expect(f.workflow.getState()).toMatchObject({
    phase: "partial",
    stopped: true,
    settledChunks: 1,
  });
});
it("keeps partial and offline handles and clears not_found without reapplying", async () => {
  using _scope = setup();
  const f = fixture(1);
  await f.ready();
  f.setRequest(async (input) => {
    const result = f.respond(input);
    return result.action === "apply"
      ? { ...result, receipt: { ...result.receipt, state: "partial", remaining: 1 } }
      : result;
  });
  await f.workflow.apply();
  expect(f.workflow.getState().phase).toBe("recovery");
  f.calls.length = 0;
  f.setRequest(async () => {
    throw new Error("offline");
  });
  await f.create().recover();
  expect(await f.store.load(destination)).not.toBeNull();
  f.setRequest(async () => {
    throw { code: "not_found" };
  });
  await f.create().recover();
  expect(await f.store.load(destination)).toBeNull();
  expect(f.calls.every((input) => input.action === "status")).toBe(true);
});
it.each(["expired", "invalid"])(
  "drops %s handles with zero automatic apply/status",
  async (mode) => {
    using _scope = setup();
    const now = 1000;
    using _now = vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(1);
    await f.store.save(destination, M.MemoryOperationId.make(uuid(9)));
    if (mode === "expired")
      vi.mocked(Date.now).mockReturnValue(now + MEMORY_IMPORT_RECOVERY_TTL_MS);
    else localStorage.setItem(memoryImportRecoveryKey(destination), "malformed");
    await f.create().recover();
    expect(f.calls).toEqual([]);
    expect(await f.store.load(destination)).toBeNull();
  },
);
it("revoke/removal discards late replies and removes the old destination handle", async () => {
  using _scope = setup();
  const f = fixture(1);
  await f.ready();
  const admitted = deferred<void>();
  const release = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await release.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.setAllowed(false);
  await f.workflow.removeDestination();
  release.resolve();
  await applying;
  expect(f.workflow.getState().receipt).toBeNull();
  expect(await f.store.load(destination)).toBeNull();
});
it("serializes 65 selected items into three persisted chunks", async () => {
  using _scope = setup();
  const f = fixture();
  await f.ready();
  f.setRequest(async (input) => {
    if (input.action === "apply")
      expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
    return f.respond(input);
  });
  await f.workflow.apply();
  expect(
    f.calls.filter((input) => input.action === "apply").map((input) => input.items.length),
  ).toEqual([32, 32, 1]);
  expect(f.workflow.getState()).toMatchObject({ phase: "completed", settledChunks: 3 });
  expect(await f.store.load(destination)).toBeNull();
});
it("session invalidation rejects late replies while preserving exact status recovery", async () => {
  using _scope = setup();
  const f = fixture(1);
  await f.ready();
  const admitted = deferred<void>();
  const reply = deferred<void>();
  f.setRequest(async (input) => {
    if (input.action === "apply") {
      admitted.resolve();
      await reply.promise;
    }
    return f.respond(input);
  });
  const applying = f.workflow.apply();
  await admitted.promise;
  f.workflow.invalidate({ ...destination, session: "reconnected" });
  reply.resolve();
  await applying;
  expect(f.workflow.getState().receipt).toBeNull();
  const handle = await f.store.load(destination);
  expect(handle).not.toBeNull();
  f.calls.length = 0;
  await f.create().recover();
  expect(f.calls).toEqual([
    {
      action: "status",
      memorySpaceId: destination.memorySpaceId,
      operationId: handle!.operationId,
    },
  ]);
});

function independentAdapter() {
  return {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
    removeItem: (key: string) => localStorage.removeItem(key),
  };
}
it("without Web Locks writes no handle and admits no apply, but recovers status", async () => {
  using _scope = setup();
  const f = fixture(1);
  await f.store.save(destination, M.MemoryOperationId.make(uuid(99)));
  using _navigator = stubGlobal("navigator", {});
  await f.workflow.recover();
  expect(f.calls.map((call) => call.action)).toEqual(["status"]);
  await f.ready();
  using write = vi.spyOn(Storage.prototype, "setItem");
  await f.workflow.apply();
  expect(write).not.toHaveBeenCalled();
  expect(f.calls.filter((call) => call.action === "apply")).toEqual([]);
  expect(await f.store.load(destination)).toBeNull();
});
it("with Web Locks independent stores cannot overwrite an unresolved slot", async () => {
  using _scope = setup();
  const entered = deferred<void>();
  const release = deferred<void>();
  const adapterA = independentAdapter();
  const originalRead = adapterA.getItem;
  const a = memoryImportRecoveryStorage({
    ...adapterA,
    getItem: async (key) => {
      entered.resolve();
      await release.promise;
      return originalRead(key);
    },
  });
  const b = memoryImportRecoveryStorage(independentAdapter());
  const savingA = a.save(destination, M.MemoryOperationId.make(uuid(101)));
  await entered.promise;
  const savingB = b.save(destination, M.MemoryOperationId.make(uuid(102)));
  const outcomeB = savingB.catch(() => null);
  release.resolve();
  await savingA;
  expect(await outcomeB).toBeNull();
  expect((await b.load(destination))?.operationId).toBe(uuid(101));
});
it("another tab binding change preserves sent X after response loss for exact status recovery", async () => {
  using _scope = setup();
  let a!: ReturnType<typeof fixture>;
  const admission = createMemoryImportAdmission(
    destination,
    () => a.workflow.invalidate(),
    independentAdapter(),
  );
  a = fixture(1, admission.recovery, admission.capturePreview);
  await a.ready();
  const sent = deferred<void>();
  const reply = deferred<void>();
  a.setRequest(async (input) => {
    if (input.action === "apply") {
      sent.resolve();
      await reply.promise;
      throw new Error("lost");
    }
    return a.respond(input);
  });
  const applying = a.workflow.apply();
  await sent.promise;
  const x = await a.store.load(destination);
  await removeMemoryImportDestination(destination, independentAdapter());
  expect((await a.store.load(destination))?.operationId).toBe(x!.operationId);
  reply.resolve();
  await applying;
  a.calls.length = 0;
  a.setRequest(async (input) => a.respond(input));
  await a.create().recover();
  expect(a.calls).toEqual([
    { action: "status", memorySpaceId: destination.memorySpaceId, operationId: x!.operationId },
  ]);
  await a.ready();
  await a.workflow.apply();
  expect(a.calls.filter((call) => call.action === "apply")).toHaveLength(1);
});
it("another tab binding generation fences old preview even before notification, then allows re-preview", async () => {
  using _scope = setup();
  let a!: ReturnType<typeof fixture>;
  const invalidated = vi.fn(() => a.workflow.invalidate());
  const admission = createMemoryImportAdmission(destination, invalidated, independentAdapter());
  a = fixture(1, admission.recovery, admission.capturePreview);
  await a.ready();
  await removeMemoryImportDestination(destination, independentAdapter());
  using write = vi.spyOn(Storage.prototype, "setItem");
  await a.workflow.apply();
  expect(invalidated).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  expect(a.calls.filter((call) => call.action === "apply")).toEqual([]);
  expect(a.workflow.getSnapshot().phase).toBe("idle");
  await a.ready();
  await a.workflow.apply();
  expect(a.calls.filter((call) => call.action === "apply")).toHaveLength(1);
});

it("deleted generation after another tab binding change rejects first preview without notification, then re-previews", async () => {
  using _scope = setup();
  let a!: ReturnType<typeof fixture>;
  const invalidated = vi.fn(() => a.workflow.invalidate());
  const admission = createMemoryImportAdmission(destination, invalidated, independentAdapter());
  a = fixture(1, admission.recovery, admission.capturePreview);
  const key = memoryImportGenerationKey(destination);
  expect(localStorage.getItem(key)).toBeNull();
  await a.ready();
  const firstGeneration = localStorage.getItem(key);
  await removeMemoryImportDestination(destination, independentAdapter());
  expect(localStorage.getItem(key)).not.toBe(firstGeneration);
  localStorage.removeItem(key);
  using write = vi.spyOn(Storage.prototype, "setItem");
  await a.workflow.apply();
  expect(write).not.toHaveBeenCalled();
  expect(a.calls.filter((call) => call.action === "apply")).toEqual([]);
  expect(await a.store.load(destination)).toBeNull();
  expect(invalidated).toHaveBeenCalledOnce();
  expect(a.workflow.getSnapshot().phase).toBe("idle");
  await a.ready();
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(localStorage.getItem(key)).not.toBe(firstGeneration);
  await a.workflow.apply();
  expect(a.calls.filter((call) => call.action === "apply")).toHaveLength(1);
});
it.each(["malformed", "00000000-0000-0000-0000-000000000000", ""])(
  "initializes malformed preview generation %j and permits apply",
  async (value) => {
    using _scope = setup();
    const key = memoryImportGenerationKey(destination);
    localStorage.setItem(key, value);
    const admission = createMemoryImportAdmission(destination, undefined, independentAdapter());
    const a = fixture(1, admission.recovery, admission.capturePreview);
    await a.ready();
    expect(localStorage.getItem(key)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await a.workflow.apply();
    expect(a.calls.filter((call) => call.action === "apply")).toHaveLength(1);
  },
);
it("rejects malformed admission generation without saving or applying and preserves sent X", async () => {
  using _scope = setup();
  let a!: ReturnType<typeof fixture>;
  const invalidated = vi.fn(() => a.workflow.invalidate());
  const admission = createMemoryImportAdmission(destination, invalidated, independentAdapter());
  a = fixture(1, admission.recovery, admission.capturePreview);
  await a.ready();
  const x = M.MemoryOperationId.make(uuid(99));
  await memoryImportRecoveryStorage(independentAdapter()).save(destination, x);
  localStorage.setItem(memoryImportGenerationKey(destination), "malformed");
  using write = vi.spyOn(Storage.prototype, "setItem");
  await a.workflow.apply();
  expect(write).not.toHaveBeenCalled();
  expect(a.calls.filter((call) => call.action === "apply")).toEqual([]);
  expect(invalidated).toHaveBeenCalledOnce();
  expect(a.workflow.getSnapshot().phase).toBe("idle");
  expect((await a.store.load(destination))?.operationId).toBe(x);
});
it("rejects repeated malformed generation at admission even when preview read the same raw value", async () => {
  using _scope = setup();
  const key = memoryImportGenerationKey(destination);
  localStorage.setItem(key, "malformed");
  let a!: ReturnType<typeof fixture>;
  const invalidated = vi.fn(() => a.workflow.invalidate());
  const admission = createMemoryImportAdmission(destination, invalidated, independentAdapter());
  a = fixture(1, admission.recovery, admission.capturePreview);
  await a.ready();
  localStorage.setItem(key, "malformed");
  using write = vi.spyOn(Storage.prototype, "setItem");
  await a.workflow.apply();
  expect(write).not.toHaveBeenCalled();
  expect(a.calls.filter((call) => call.action === "apply")).toEqual([]);
  expect(await a.store.load(destination)).toBeNull();
  expect(invalidated).toHaveBeenCalledOnce();
  expect(a.workflow.getSnapshot().phase).toBe("idle");
});
