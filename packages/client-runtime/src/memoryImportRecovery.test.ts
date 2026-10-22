import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  MEMORY_IMPORT_RECOVERY_TTL_MS as TTL,
  MemoryImportRecoveryHandle,
  createMemoryImportRecoveryStore,
  decodeMemoryImportRecovery,
  encodeMemoryImportRecovery,
  memoryImportRecoveryKey,
} from "./memoryImportRecovery.ts";
import {
  createMemoryImportWorkflow,
  memoryImportChunks,
  memoryImportIssueReason,
  memoryImportRequestFailureMessage,
  sameMemoryImportFence,
  reduceMemoryImportProgress,
  initialMemoryImportWorkflowState,
} from "./memoryImportWorkflow.ts";

const decodeHandle = Schema.decodeUnknownSync(MemoryImportRecoveryHandle);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const destination = {
  environmentId: M.EnvironmentId.make("device"),
  memorySpaceId: M.MemorySpaceId.make(uuid(1)),
};
const operationId = M.MemoryOperationId.make(uuid(2));
const sourceId = M.MemoryImportSourceId.make(uuid(3));
const fence = { ...destination, session: "connection-1" };
const selections = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    sourceItemKey: `item-${i}`,
    sourceFingerprint: "a".repeat(64),
    scope: { kind: "user" as const },
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function storageFixture() {
  const data = new Map<string, string>();
  let now = 1000;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  return {
    data,
    storage,
    setNow: (value: number) => {
      now = value;
    },
    store: createMemoryImportRecoveryStore(storage, () => now),
  };
}
const syncStatus = M.MemorySyncStatus.make({
  memorySpaceId: destination.memorySpaceId,
  state: "online",
  pendingSync: 0,
  quarantined: 0,
  parked: 0,
  lastSuccessfulSyncAtUtc: null,
  lastHubSequence: 0,
  processing: {
    lastReceivedHubSequence: 0,
    receiveLag: null,
    deferred: 0,
    oldestDeferredAtUtc: null,
    unindexedItems: 0,
    scannerHeldItems: 0,
    scannerPendingItems: 0,
    missingParentItems: 0,
    pendingCleanupItems: 0,
    reportBacklog: 0,
    reportFailed: 0,
    hubAdmissionFailures: 0,
    indexCoverage: {
      status: "available",
      eligibleItems: 0,
      indexedItems: 0,
      unindexedItems: 0,
      projectionWatermark: 0,
    },
  },
  storage: {
    quotas: [],
    tables: [],
    measuredAtUtc: null,
    dbFileBytes: null,
    walBytes: null,
    freelistBytes: null,
    freelistRatio: null,
    retentionFloor: 0,
    checkpointSequence: 0,
    compaction: {
      lastRunAtUtc: null,
      removedRows: 0,
      reclaimedLogicalBytes: 0,
      reclaimableLogicalBytes: 0,
      blockedReasons: [],
    },
    ftsAdmission: {
      state: "open",
      changedAtUtc: null,
      lastMeasuredAtUtc: null,
      allocatedBytes: null,
      measurementStatus: "unavailable",
    },
    growth: {
      current: null,
      deltas: ([1, 7, 30] as const).flatMap((days) =>
        M.MemoryStorageMetric.literals.map((metric) => ({
          days,
          metric,
          status: "unavailable" as const,
          baselineAtUtc: null,
          currentAtUtc: null,
          elapsedMs: null,
          deltaBytes: null,
          reason: "missing_baseline" as const,
        })),
      ),
    },
    warnings: [],
  },
});

function workflowFixture(count = 65) {
  const fixture = storageFixture();
  const calls: M.MemoryImportProviderInput[] = [];
  const items = selections(count);
  let permitted = true;
  let nextId = 10;
  const preview = {
    action: "preview" as const,
    sourceId,
    sessionId: "import-session",
    items: items.map((item) => ({ ...item, byteCount: 1, mappingRequired: false })),
  };
  function result(input: M.MemoryImportProviderInput): M.MemoryImportProviderResult {
    if (input.action === "discover") return { action: "discover", sources: [] };
    if (input.action === "preview") return preview;
    return {
      action: input.action,
      receipt: {
        operationId: input.operationId,
        sourceId,
        sessionId: "import-session",
        sessionNewItems: 1,
        sessionBodyBytes: 1,
        state: "completed",
        remaining: 0,
        items: [],
      },
      syncStatus,
    };
  }
  let respond = async (input: M.MemoryImportProviderInput) => result(input);
  const createWorkflow = () =>
    createMemoryImportWorkflow({
      fence,
      recovery: fixture.store,
      canImport: () => permitted,
      operationId: () => M.MemoryOperationId.make(uuid(nextId++)),
      request: async (_, input) => {
        calls.push(input);
        return respond(input);
      },
    });
  const workflow = createWorkflow();
  return {
    ...fixture,
    createWorkflow,
    workflow,
    calls,
    items,
    result,
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
    setPermitted: (value: boolean) => {
      permitted = value;
    },
    ready: async () => {
      await workflow.discover("codex");
      await workflow.preview(sourceId);
      workflow.select(items);
    },
  };
}

describe("body-free import recovery", () => {
  it("round-trips branded handles and expires at exactly 30 days", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    expect(handle.expiresAt - handle.savedAt).toBe(TTL);
    const raw = encodeMemoryImportRecovery(handle);
    expect(Object.keys(JSON.parse(raw).handle).sort()).toEqual([
      "environmentId",
      "expiresAt",
      "memorySpaceId",
      "operationId",
      "savedAt",
    ]);
    expect(decodeMemoryImportRecovery(raw, handle.expiresAt - 1)).toEqual(handle);
    expect(decodeMemoryImportRecovery(raw, handle.expiresAt)).toBeNull();
    expect(decodeMemoryImportRecovery(raw, handle.savedAt - 1)).toBeNull();
    f.setNow(handle.expiresAt);
    expect(await f.store.load(destination)).toBeNull();
    expect(f.data.size).toBe(0);
  });
  it.each(["garbage", "null", '{"version":2,"handle":{}}', '{"version":1,"handle":{}}'])(
    "removes malformed metadata: %s",
    async (raw) => {
      const f = storageFixture();
      f.data.set(memoryImportRecoveryKey(destination), raw);
      expect(await f.store.load(destination)).toBeNull();
      expect(f.data.size).toBe(0);
    },
  );
  it("rejects extra private fields and non-exact TTLs", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    for (const extra of [
      { body: "private" },
      { expiresAt: handle.expiresAt + 1 },
      { operationId: "bad" },
    ]) {
      expect(
        decodeMemoryImportRecovery(
          JSON.stringify({ version: 1, handle: { ...handle, ...extra } }),
          1000,
        ),
      ).toBeNull();
    }
    expect(() => decodeHandle({ ...handle, savedAt: NaN })).toThrow();
    const wider = { ...handle, body: "private" };
    expect(encodeMemoryImportRecovery(wider)).not.toContain("private");
  });
  it("serializes overlapping saves, never replaces an unresolved operation, and isolates destinations", async () => {
    const f = storageFixture();
    const first = f.store.save(destination, operationId);
    const second = f.store.save(destination, M.MemoryOperationId.make(uuid(4)));
    await first;
    await expect(second).rejects.toThrow("previous import");
    const other = { ...destination, environmentId: M.EnvironmentId.make("other") };
    await f.store.save(other, operationId);
    await f.store.clear(destination, M.MemoryOperationId.make(uuid(4)));
    expect(await f.store.load(destination)).not.toBeNull();
    await f.store.clear(destination);
    expect(await f.store.load(other)).not.toBeNull();
  });
  it("removes wrong-destination and clock-regressed handles", async () => {
    const f = storageFixture();
    const handle = await f.store.save(destination, operationId);
    f.data.set(
      memoryImportRecoveryKey(destination),
      encodeMemoryImportRecovery({ ...handle, environmentId: M.EnvironmentId.make("other") }),
    );
    expect(await f.store.load(destination)).toBeNull();
    await f.store.save(destination, operationId);
    f.setNow(999);
    expect(await f.store.load(destination)).toBeNull();
  });
});

describe("import workflow admission and fences", () => {
  it("snapshots selectors, bounds and sequences chunks, with distinct stable IDs", async () => {
    const f = workflowFixture();
    await f.ready();
    f.items[0]!.sourceItemKey = "changed-after-preview";
    f.setRespond(async (input) => {
      if (input.action === "apply")
        expect((await f.store.load(destination))?.operationId).toBe(input.operationId);
      return f.result(input);
    });
    await f.workflow.apply();
    const applies = f.calls.filter((input) => input.action === "apply");
    expect(applies.map((input) => input.items.length)).toEqual([32, 32, 1]);
    expect(applies[0]!.items[0]!.sourceItemKey).toBe("item-0");
    expect(new Set(applies.map((input) => input.operationId)).size).toBe(3);
    expect(f.workflow.getState()).toMatchObject({ phase: "completed", settledChunks: 3 });
    expect(await f.store.load(destination)).toBeNull();
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
  it("waits for storage success and does not apply after failed persistence", async () => {
    const f = workflowFixture(1);
    const gate = deferred<void>();
    const saved = deferred<void>();
    f.storage.setItem = async () => {
      saved.resolve();
      await gate.promise;
    };
    await f.ready();
    const applying = f.workflow.apply();
    await saved.promise;
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
    gate.reject(new Error("storage unavailable"));
    await applying;
    expect(f.workflow.getSnapshot()).toMatchObject({
      phase: "save_failed",
      message: expect.stringContaining("Nothing was imported from this batch"),
    });
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
  });
  it("stops future chunks while settling the admitted chunk as partial", async () => {
    const f = workflowFixture();
    await f.ready();
    const gate = deferred<M.MemoryImportProviderResult>();
    const admitted = deferred<M.MemoryImportProviderInput>();
    f.setRespond((input) => {
      admitted.resolve(input);
      return gate.promise;
    });
    const applying = f.workflow.apply();
    const input = await admitted.promise;
    f.workflow.stop();
    gate.resolve(f.result(input));
    await applying;
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    expect(f.workflow.getState()).toMatchObject({
      phase: "partial",
      settledChunks: 1,
      stopped: true,
    });
  });
  it("lost responses survive restart and offline recovery calls only the exact status ID", async () => {
    const f = workflowFixture();
    await f.ready();
    f.setRespond(async () => {
      throw new Error("offline");
    });
    await f.workflow.apply();
    const handle = await f.store.load(destination);
    expect(handle).not.toBeNull();
    const before = f.calls.length;
    const restarted = f.createWorkflow();
    await restarted.recover();
    expect(f.calls.slice(before)).toEqual([
      {
        action: "status",
        memorySpaceId: destination.memorySpaceId,
        operationId: handle!.operationId,
      },
    ]);
    expect(await f.store.load(destination)).toEqual(handle);
    await expect(restarted.apply()).rejects.toThrow("Preview");
    f.setRespond(async (input) => f.result(input));
    await restarted.recover();
    expect(await f.store.load(destination)).toBeNull();
    expect(restarted.getState().phase).toBe("repreview");
  });
  it("not_found removes the handle without claiming zero applied", async () => {
    const f = workflowFixture(1);
    await f.store.save(destination, operationId);
    f.setRespond(async () => {
      throw { code: "not_found" };
    });
    await f.workflow.recover();
    expect(await f.store.load(destination)).toBeNull();
    expect(f.workflow.getState()).toMatchObject({
      phase: "repreview",
      message: expect.stringContaining("may have been applied"),
    });
  });
  it.each(["environment", "space", "session"])(
    "discards late status after %s changes",
    async (change) => {
      const f = workflowFixture(1);
      await f.store.save(destination, operationId);
      const started = deferred<M.MemoryImportProviderInput>();
      const gate = deferred<M.MemoryImportProviderResult>();
      f.setRespond((input) => {
        started.resolve(input);
        return gate.promise;
      });
      const recovering = f.workflow.recover();
      const input = await started.promise;
      const next = {
        ...fence,
        ...(change === "environment"
          ? { environmentId: M.EnvironmentId.make("new") }
          : change === "space"
            ? { memorySpaceId: M.MemorySpaceId.make(uuid(9)) }
            : { session: "new" }),
      };
      expect(sameMemoryImportFence(fence, next)).toBe(false);
      f.workflow.invalidate(next);
      gate.resolve(f.result(input));
      await recovering;
      expect(f.workflow.getState().phase).toBe("idle");
      expect(await f.store.load(destination)).not.toBeNull();
    },
  );
  it("clears matching destination on rebind/revoke/removal and discards late apply", async () => {
    const f = workflowFixture();
    await f.ready();
    const started = deferred<M.MemoryImportProviderInput>();
    const gate = deferred<M.MemoryImportProviderResult>();
    f.setRespond((input) => {
      started.resolve(input);
      return gate.promise;
    });
    const applying = f.workflow.apply();
    const input = await started.promise;
    await f.workflow.removeDestination();
    gate.resolve(f.result(input));
    await applying;
    expect(f.workflow.getState().phase).toBe("idle");
    expect(await f.store.load(destination)).toBeNull();
  });
  it("retains partial receipts and never automatically reapplies them", async () => {
    const f = workflowFixture();
    await f.ready();
    f.setRespond(async (input) => {
      const result = f.result(input);
      return result.action === "apply" || result.action === "status"
        ? { ...result, receipt: { ...result.receipt, state: "partial", remaining: 1 } }
        : result;
    });
    await f.workflow.apply();
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    await f.workflow.recover();
    expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(1);
    expect(f.workflow.getState().phase).toBe("recovery");
    expect(await f.store.load(destination)).not.toBeNull();
  });
  it("rejects stale selection, invalidated previews and revoked execution permission", async () => {
    const f = workflowFixture(1);
    await f.workflow.preview(sourceId);
    f.workflow.select([{ ...f.items[0]!, sourceFingerprint: "b".repeat(64) }]);
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
    await f.ready();
    f.setPermitted(false);
    await f.workflow.apply();
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
    expect(await f.store.load(destination)).toBeNull();
    f.workflow.invalidate();
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
  it("does not use an old unresolved operation as new apply authority", async () => {
    const f = workflowFixture(1);
    await f.store.save(destination, operationId);
    await f.ready();
    await f.workflow.apply();
    expect(f.workflow.getSnapshot().phase).toBe("recovery");
    expect((await f.store.load(destination))?.operationId).toBe(operationId);
    await expect(f.workflow.retry()).rejects.toThrow("Preview");
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
  });
  it("bounds selection and disallows duplicate keys", () => {
    expect(() => memoryImportChunks([])).toThrow();
    expect(() => memoryImportChunks(selections(129))).toThrow();
    expect(() => memoryImportChunks([...selections(1), ...selections(1)])).toThrow();
  });
});

describe("pure import progress", () => {
  it("settles an admitted chunk after Stop without mutating prior progress", () => {
    const f = workflowFixture(1);
    const response = f.result({
      action: "status",
      memorySpaceId: destination.memorySpaceId,
      operationId,
    });
    if (response.action !== "status") throw new Error("Status fixture required");
    const before = { ...initialMemoryImportWorkflowState, phase: "applying" as const };
    const stopped = reduceMemoryImportProgress(before, { type: "stop", inFlight: true });
    const received = reduceMemoryImportProgress(stopped, {
      type: "receipt",
      receipt: response.receipt,
    });
    const finished = reduceMemoryImportProgress(received, { type: "finish", totalChunks: 1 });
    expect(before).toMatchObject({ phase: "applying", stopped: false, settledChunks: 0 });
    expect(finished).toMatchObject({ phase: "partial", stopped: true, settledChunks: 1 });
  });
  it.each(["stop", "revoke", "invalidate"])(
    "prevents admission when %s occurs during persistence",
    async (action) => {
      const f = workflowFixture(1);
      const saved = deferred<void>();
      const gate = deferred<void>();
      const write = f.storage.setItem;
      f.storage.setItem = async (key, value) => {
        write(key, value);
        saved.resolve();
        await gate.promise;
      };
      await f.ready();
      const applying = f.workflow.apply();
      await saved.promise;
      if (action === "stop") f.workflow.stop();
      if (action === "revoke") f.setPermitted(false);
      if (action === "invalidate") f.workflow.invalidate({ ...fence, session: "changed" });
      gate.resolve();
      await applying;
      expect(f.calls.some((input) => input.action === "apply")).toBe(false);
      expect(await f.store.load(destination)).toBeNull();
    },
  );
  it("expired handles cannot trigger apply or status on restart", async () => {
    const f = workflowFixture(1);
    const handle = await f.store.save(destination, operationId);
    f.setNow(handle.expiresAt);
    await f.workflow.recover();
    expect(f.calls).toHaveLength(0);
    expect(f.workflow.getState().phase).toBe("repreview");
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
  });
});

describe("preview mapping changes", () => {
  it("invalidates a confirmed preview when the selection or scope changes", async () => {
    const f = workflowFixture(2);
    await f.ready();
    f.workflow.select([
      {
        ...f.items[0]!,
        scope: {
          kind: "thread",
          thread: {
            environmentId: destination.environmentId,
            threadId: M.ThreadId.make("other-thread"),
          },
        },
      },
    ]);
    expect(f.workflow.getState().phase).toBe("repreview");
    await expect(f.workflow.apply()).rejects.toThrow("Preview");
    expect(f.calls.some((input) => input.action === "apply")).toBe(false);
  });
});

describe("session recovery overlap", () => {
  it("can check a saved ID on a new session while an old response is still pending", async () => {
    const f = workflowFixture(1);
    await f.ready();
    const admitted = deferred<M.MemoryImportProviderInput>();
    const lost = deferred<M.MemoryImportProviderResult>();
    f.setRespond((input) => {
      admitted.resolve(input);
      return lost.promise;
    });
    const applying = f.workflow.apply();
    const input = await admitted.promise;
    f.workflow.invalidate({ ...fence, session: "reconnected" });
    f.setRespond(async (next) => f.result(next));
    await f.workflow.recover();
    expect(f.workflow.getState().phase).toBe("repreview");
    lost.resolve(f.result(input));
    await applying;
    expect(f.workflow.getState().phase).toBe("repreview");
    expect(f.calls.filter((call) => call.action === "apply")).toHaveLength(1);
  });
});

describe("scope snapshots", () => {
  it("freezes project and thread mapping while callers change their selections", () => {
    const scope = {
      kind: "thread" as const,
      thread: { environmentId: destination.environmentId, threadId: M.ThreadId.make("original") },
      projectKey: { kind: "explicit" as const, sharedProjectId: "original" },
    };
    const project = {
      environmentId: destination.environmentId,
      projectId: M.ProjectId.make("original"),
    };
    const chunks = memoryImportChunks([{ ...selections(1)[0]!, scope, project }]);
    scope.thread.threadId = M.ThreadId.make("changed");
    scope.projectKey.sharedProjectId = "changed";
    project.projectId = M.ProjectId.make("changed");
    expect(chunks[0]![0]).toMatchObject({
      scope: { thread: { threadId: "original" }, projectKey: { sharedProjectId: "original" } },
      project: { projectId: "original" },
    });
  });
});

describe("observable import progress and retry", () => {
  it("publishes immutable intermediate snapshots and stops notifying after unsubscribe", async () => {
    const f = workflowFixture(33);
    await f.ready();
    const gate = deferred<M.MemoryImportProviderResult>();
    const second = deferred<M.MemoryImportProviderInput>();
    let count = 0;
    f.setRespond(async (input) => {
      if (input.action === "apply" && ++count === 2) {
        second.resolve(input);
        return gate.promise;
      }
      return f.result(input);
    });
    const snapshots: ReturnType<typeof f.workflow.getSnapshot>[] = [];
    const unsubscribe = f.workflow.subscribe(() => snapshots.push(f.workflow.getSnapshot()));
    const before = f.workflow.getSnapshot();
    expect(f.workflow.getSnapshot()).toBe(before);
    const applying = f.workflow.apply();
    const input = await second.promise;
    expect(snapshots.some((s) => s.phase === "applying" && s.settledChunks === 1)).toBe(true);
    expect(before.phase).toBe("previewed");
    expect(Object.isFrozen(f.workflow.getSnapshot().chunkSummaries[0]?.outcomes)).toBe(true);
    expect(Object.isFrozen(f.workflow.getSnapshot().receipt?.items)).toBe(true);
    unsubscribe();
    const notifications = snapshots.length;
    gate.resolve(f.result(input));
    await applying;
    expect(snapshots).toHaveLength(notifications);
    const final = f.workflow.getSnapshot();
    f.workflow.stop();
    const stopped = f.workflow.getSnapshot();
    f.workflow.stop();
    expect(f.workflow.getSnapshot()).toBe(stopped);
    expect(final.settledChunks).toBe(2);
  });

  it.each([1, 2])(
    "explicitly retries failed save %i with identical ID and selectors",
    async (failAt) => {
      const f = workflowFixture(33);
      const write = f.storage.setItem;
      const attempted: string[] = [];
      let failed = true;
      f.storage.setItem = (key, value) => {
        attempted.push(value);
        if (attempted.length === failAt && failed) throw new Error("unavailable");
        write(key, value);
      };
      await f.ready();
      await f.workflow.apply();
      expect(f.workflow.getSnapshot()).toMatchObject({
        phase: "save_failed",
        settledChunks: failAt - 1,
      });
      expect(f.calls.filter((i) => i.action === "apply")).toHaveLength(failAt - 1);
      await expect(f.workflow.apply()).rejects.toThrow("Preview");
      failed = false;
      await f.workflow.retry();
      const handles = attempted.map((value) => decodeMemoryImportRecovery(value, 1000)!);
      expect(handles[failAt]!.operationId).toBe(handles[failAt - 1]!.operationId);
      const applies = f.calls.filter((i) => i.action === "apply");
      expect(applies.map((i) => i.items)).toEqual([f.items.slice(0, 32), f.items.slice(32)]);
      expect(new Set(applies.map((i) => i.operationId)).size).toBe(2);
      expect(f.workflow.getSnapshot()).toMatchObject({ phase: "completed", settledChunks: 2 });
    },
  );

  it("a write followed by rejection requires status, never retry apply", async () => {
    const f = workflowFixture(1);
    const write = f.storage.setItem;
    f.storage.setItem = (key, value) => {
      write(key, value);
      throw new Error("lost acknowledgement");
    };
    await f.ready();
    await f.workflow.apply();
    const handle = await f.store.load(destination);
    expect(f.workflow.getSnapshot().phase).toBe("recovery");
    await expect(f.workflow.retry()).rejects.toThrow("Preview");
    await f.workflow.recover();
    expect(f.calls.filter((i) => i.action === "apply")).toEqual([]);
    expect(f.calls.filter((i) => i.action === "status")).toEqual([
      {
        action: "status",
        memorySpaceId: destination.memorySpaceId,
        operationId: handle!.operationId,
      },
    ]);
  });

  it.each(["completed", "partial", "stop"] as const)(
    "preserves capacity and later outcomes with %s",
    async (ending) => {
      const f = workflowFixture(33);
      await f.ready();
      let count = 0;
      let last: M.MemoryImportReceipt | null = null;
      f.setRespond(async (input) => {
        if (input.action === "status" && last !== null)
          return { action: "status", receipt: last, syncStatus };
        const response = f.result(input);
        if (input.action !== "apply" || response.action !== "apply") return response;
        const first = ++count === 1;
        if (!first && ending === "stop") f.workflow.stop();
        last = {
          ...response.receipt,
          state: !first && ending === "partial" ? "partial" : "completed",
          remaining: !first && ending === "partial" ? 1 : 0,
          items: [
            {
              sourceItemKey: "private-key",
              memoryId: null,
              revisionId: null,
              ...(first
                ? {
                    outcome: "rejected" as const,
                    issue: "capacity_exceeded" as const,
                    capacity: {
                      code: "capacity_exceeded" as const,
                      dimension: "body" as const,
                      current: 128,
                      limit: 128,
                      reclaimable: 0,
                    },
                  }
                : { outcome: "noop" as const }),
            },
          ],
        };
        return { ...response, receipt: last };
      });
      await f.workflow.apply();
      const snapshot = f.workflow.getSnapshot();
      expect(snapshot.totals).toEqual({
        outcomes: { rejected: 1, noop: 1 },
        issues: { capacity_exceeded: 1 },
        capacity: { body: 1 },
      });
      expect(snapshot.chunkSummaries).toHaveLength(2);
      expect(JSON.stringify(snapshot.chunkSummaries)).not.toContain("private-key");
      expect(snapshot.phase).toBe(
        ending === "partial" ? "recovery" : ending === "stop" ? "partial" : "completed",
      );
      if (ending === "partial") {
        await f.workflow.recover();
        await f.workflow.recover();
        expect(f.workflow.getSnapshot().totals).toEqual(snapshot.totals);
        expect(f.workflow.getSnapshot().chunkSummaries).toHaveLength(2);
      }
    },
  );
});

describe("import subscription isolation and admission", () => {
  it.each([
    {
      kind: "Error",
      error: Object.assign(
        new Error("synthetic-id private-body-marker", {
          cause: { id: "synthetic-id", body: "private-body-marker" },
        }),
        { id: "synthetic-id", body: "private-body-marker" },
      ),
    },
    {
      kind: "object",
      error: { id: "synthetic-id", body: "private-body-marker" },
    },
  ])("isolates a throwing $kind listener and reports only safe text", async ({ error }) => {
    const f = workflowFixture(33);
    await f.ready();
    await Promise.resolve();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshots: ReturnType<typeof f.workflow.getSnapshot>[] = [];
    const unsubscribe = f.workflow.subscribe(() => {
      throw error;
    });
    f.workflow.subscribe(() => snapshots.push(f.workflow.getSnapshot()));
    try {
      await f.workflow.apply();
      expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(2);
      expect(f.workflow.getSnapshot()).toMatchObject({ phase: "completed", settledChunks: 2 });
      expect(snapshots.at(-1)).toBe(f.workflow.getSnapshot());
      expect(report).toHaveBeenCalled();
      for (const args of report.mock.calls) {
        expect(args).toEqual(["Memory import listener failed"]);
      }
    } finally {
      unsubscribe();
      report.mockRestore();
    }
  });

  it.each(
    (["invalidate", "destination", "stop", "revoke"] as const).flatMap((action) =>
      [0, 1].map((admittedChunks) => ({ action, admittedChunks })),
    ),
  )(
    "does not admit an apply after $action in applying notification with $admittedChunks chunks already sent",
    async ({ action, admittedChunks }) => {
      const f = workflowFixture(33);
      await f.ready();
      let observed = false;
      f.workflow.subscribe(() => {
        const snapshot = f.workflow.getSnapshot();
        if (observed || snapshot.phase !== "applying" || snapshot.settledChunks !== admittedChunks)
          return;
        observed = true;
        if (action === "invalidate") f.workflow.invalidate();
        if (action === "destination")
          f.workflow.invalidate({
            environmentId: M.EnvironmentId.make("other-device"),
            memorySpaceId: M.MemorySpaceId.make(uuid(900)),
            session: "other-session",
          });
        if (action === "stop") f.workflow.stop();
        if (action === "revoke") f.setPermitted(false);
      });
      await f.workflow.apply();
      expect(observed).toBe(true);
      expect(f.calls.filter((input) => input.action === "apply")).toHaveLength(admittedChunks);
      expect(await f.store.load(destination)).toBeNull();
      expect(f.workflow.getSnapshot().phase).toBe(
        action === "invalidate" || action === "destination" ? "idle" : "partial",
      );
    },
  );

  it.each(["invalidate", "destination", "stop", "revoke"] as const)(
    "keeps a recovery handle without sending status after %s in checking notification",
    async (action) => {
      const f = workflowFixture(1);
      await f.store.save(destination, operationId);
      f.workflow.subscribe(() => {
        if (f.workflow.getSnapshot().phase !== "checking") return;
        if (action === "invalidate") f.workflow.invalidate();
        if (action === "destination")
          f.workflow.invalidate({ ...fence, environmentId: M.EnvironmentId.make("other-device") });
        if (action === "stop") f.workflow.stop();
        if (action === "revoke") f.setPermitted(false);
      });
      await f.workflow.recover();
      expect(f.calls).toHaveLength(0);
      expect((await f.store.load(destination))?.operationId).toBe(operationId);
      expect(f.workflow.getSnapshot().phase).toBe(
        action === "invalidate" || action === "destination" ? "idle" : "recovery",
      );
    },
  );

  it("preserves the new idle generation when receipt notification invalidates recovery", async () => {
    const f = workflowFixture(1);
    await f.store.save(destination, operationId);
    let observed = false;
    f.workflow.subscribe(() => {
      if (f.workflow.getSnapshot().receipt === null) return;
      observed = true;
      f.workflow.invalidate();
    });
    await f.workflow.recover();
    await Promise.resolve();
    expect(observed).toBe(true);
    expect(f.workflow.getSnapshot()).toEqual(initialMemoryImportWorkflowState);
    expect(f.calls.map((input) => input.action)).toEqual(["status"]);
  });

  it("coalesces synchronous changes into the final snapshot and excludes removed listeners", async () => {
    const f = workflowFixture(1);
    const snapshots: ReturnType<typeof f.workflow.getSnapshot>[] = [];
    const removed = vi.fn();
    let unsubscribeRemoved = () => {};
    f.workflow.subscribe(() => {
      snapshots.push(f.workflow.getSnapshot());
      unsubscribeRemoved();
    });
    unsubscribeRemoved = f.workflow.subscribe(removed);
    f.workflow.stop();
    f.workflow.invalidate();
    expect(snapshots).toHaveLength(0);
    await Promise.resolve();
    expect(snapshots).toEqual([f.workflow.getSnapshot()]);
    expect(snapshots[0]).toEqual(initialMemoryImportWorkflowState);
    expect(removed).not.toHaveBeenCalled();
    const removedBeforeFlush = vi.fn();
    const unsubscribe = f.workflow.subscribe(removedBeforeFlush);
    f.workflow.stop();
    unsubscribe();
    await Promise.resolve();
    expect(removedBeforeFlush).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toBe(f.workflow.getSnapshot());
  });
});

describe("memoryImportIssueReason", () => {
  it("names the refusals a person can act on", () => {
    expect(memoryImportIssueReason("limit_exceeded")).toBe("This folder has more than 128 items.");
    expect(memoryImportIssueReason("scope_unmapped")).toBe(
      "Items in projects/ need a project scope.",
    );
    expect(memoryImportIssueReason("source_missing")).toBe(
      "That memory store or profile is not on this device.",
    );
  });

  it("shows a typed refusal and leaves other failures unnamed", () => {
    expect(
      memoryImportRequestFailureMessage(new M.MemoryImportRpcError({ issue: "limit_exceeded" })),
    ).toBe(memoryImportIssueReason("limit_exceeded"));
    expect(memoryImportRequestFailureMessage(new Error("network"))).toBeNull();
    expect(memoryImportRequestFailureMessage({ _tag: "MemoryRpcError", code: "unavailable" })).toBe(
      null,
    );
  });
});
