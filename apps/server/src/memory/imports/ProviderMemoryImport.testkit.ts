import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import { parseCodexMemory } from "./CodexMemoryImporter.ts";
import { parseClaudeMemory } from "./ClaudeMemoryImporter.ts";
import { parseOmoMemory } from "./OmoMemoryImporter.ts";
import { parseAsideMemory } from "./AsideMemoryImporter.ts";
import { buildMemoryImportFixture } from "./MemoryImportFixtures.fixture.ts";
import type { MemoryImportFixtureProfile } from "./MemoryImportFixtures.fixture.ts";
import type {
  ImportBatch,
  ImportItem,
  ImportPorts,
  ImportPrimitives,
  ImportRegistration,
  ImportSnapshot,
  MemoryImportParsers,
  MemoryImportReaderShape,
  PreparedImportCommit,
} from "./MemoryImportTypes.ts";
import { makeProviderMemoryImport } from "./ProviderMemoryImport.ts";
import { assert } from "@effect/vitest";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(uuid(1));
export const environmentId = M.EnvironmentId.make("synthetic-coordinator");
export const stamp = M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z");
const isImportError = Schema.is(M.MemoryImportRpcError);
export const isPayload = Schema.is(M.MemoryPayload);
export const parsers: MemoryImportParsers = {
  codex: parseCodexMemory,
  claude: parseClaudeMemory,
  omo: parseOmoMemory,
  aside: parseAsideMemory,
};
const processing: M.MemoryProcessingStatus = {
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
};
export const storage: M.MemoryStorageStatus = {
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
      (
        [
          "memoryLogicalBytes",
          "memoryAllocatedBytes",
          "ftsAllocatedBytes",
          "dbFileBytes",
          "walBytes",
          "freelistBytes",
        ] as const
      ).map((metric) => ({
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
};
export const sync: M.MemorySyncStatus = {
  memorySpaceId: space,
  state: "offline",
  pendingSync: 1,
  quarantined: 0,
  parked: 0,
  lastSuccessfulSyncAtUtc: null,
  lastHubSequence: 0,
  storage,
  processing,
};
export const harness = (initial: ImportSnapshot) => {
  let serial = 100;
  let now = Date.parse(stamp);
  let source = initial;
  let reads = 0;
  let discoveries = 0;
  let ready = true;
  let retired = false;
  let commitError: Service.MemoryServiceError | undefined;
  let registration: ImportRegistration | undefined;
  let batch: ImportBatch | undefined;
  const items = new Map<string, ImportItem>();
  const commits: PreparedImportCommit[] = [];
  const addresses: M.EnvironmentId[] = [];
  const primitives: ImportPrimitives = {
    uuid: () => uuid(serial++),
    now: () => Effect.sync(() => now),
    environmentId,
  };
  const reader: MemoryImportReaderShape = {
    discover: () =>
      Effect.sync(() => {
        discoveries++;
        return [
          {
            slot: source.slot,
            parserVersion: source.parserVersion,
            profile: source.profile,
            sourceLocator: source.sourceLocator,
            label: "Synthetic source",
          },
        ];
      }),
    read: () =>
      Effect.sync(() => {
        reads++;
        return source;
      }),
  };
  const ports: ImportPorts = {
    readRegistration: (a, permit) =>
      permit.pipe(
        Effect.andThen(
          Effect.sync(() => {
            addresses.push(a.environmentId);
            return registration;
          }),
        ),
      ),
    saveRegistration: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if ((registration?.version ?? null) !== a.expectedVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        registration = a.next;
        return registration;
      }),
    preflightBatch: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        addresses.push(a.environmentId);
        if (
          batch &&
          batch.operationId === a.operationId &&
          batch.selectionDigest !== a.selectionDigest
        )
          return yield* new M.MemoryImportRpcError({ issue: "operation_id_reused" });
        if (retired) return { kind: "retired" as const };
        if (!batch || batch.operationId !== a.operationId) return { kind: "new" as const };
        return batch.receipt.state === "completed"
          ? { kind: "completed" as const, receipt: batch.receipt }
          : { kind: "partial" as const, batch, receipt: batch.receipt };
      }),
    readReceipt: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        addresses.push(a.environmentId);
        if (!batch || batch.operationId !== a.operationId || retired)
          return yield* new M.MemoryRpcError({ code: "not_found" });
        return batch.receipt;
      }),
    readItem: (a, permit) =>
      permit.pipe(Effect.andThen(Effect.sync(() => items.get(a.sourceItemKey)))),
    findMatch: (_a, permit) => permit.pipe(Effect.as({ kind: "none" as const })),
    prepareTarget: (_a, permit) =>
      permit.pipe(
        Effect.as({
          identity: null,
          heads: [],
          forgotten: false,
          pendingForget: false,
          acceptedParent: null,
          alias: null,
        }),
      ),
    binding: (a, permit) =>
      permit.pipe(Effect.as({ ...a, projectKey: null, repositoryKey: null, version: 0 })),
    resolveProjectKey: () => Effect.succeed(null),
    commit: (a, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if (commitError && !a.rejectOnly) return yield* commitError;
        if (!registration || registration.version !== a.registrationVersion)
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const result: M.MemoryImportItemResult = {
          sourceItemKey: a.next.sourceItemKey,
          outcome: a.rejectOnly ? "rejected" : a.next.outcome,
          memoryId:
            a.next.outcome === "rejected" || a.next.outcome === "suppressed"
              ? null
              : a.next.memoryId,
          revisionId:
            a.next.outcome === "rejected" || a.next.outcome === "suppressed"
              ? null
              : a.selection.revisionId,
          ...(a.next.rejected && a.next.outcome === "rejected"
            ? { issue: a.next.rejected.issue }
            : {}),
        };
        if (a.rejectOnly) {
          Object.assign(result, {
            outcome: "rejected",
            memoryId: null,
            revisionId: null,
            ...a.rejectOnly,
          });
        }
        commits.push(a);
        if (!a.rejectOnly) items.set(a.next.sourceItemKey, a.next);
        const selections = a.batch.selections.map((s) =>
          s.selector.sourceItemKey === a.next.sourceItemKey ? { ...s, result } : s,
        );
        const remaining = selections.filter((s) => !s.result).length;
        batch = {
          ...a.batch,
          selections,
          receipt: {
            ...a.batch.receipt,
            items: selections.flatMap((s) => (s.result ? [s.result] : [])),
            remaining,
            state: remaining ? "partial" : "completed",
          },
        };
        registration = { ...registration, version: registration.version + 1 };
        return result;
      }),
    readiness: () =>
      Effect.sync(() => ({
        memorySpaceId: space,
        bootstrap: ready ? ("ready" as const) : ("staging" as const),
      })),
    requireBootstrap: () =>
      ready ? Effect.void : Effect.fail(new M.MemoryHubError({ code: "bootstrap_required" })),
    syncStatus: (_a, permit) => permit.pipe(Effect.as(sync)),
  };
  const make = (
    overrides: Partial<ImportPorts> = {},
    parserOverrides: Partial<MemoryImportParsers> = {},
  ) =>
    makeProviderMemoryImport(
      { ...ports, ...overrides },
      reader,
      { ...parsers, ...parserOverrides },
      primitives,
    );
  return {
    ports,
    reader,
    primitives,
    make,
    commits,
    addresses,
    counts: () => ({ reads, discoveries }),
    source: (s: ImportSnapshot) => {
      source = s;
    },
    now: (n: number) => {
      now = n;
    },
    ready: () => {
      ready = false;
    },
    retire: () => {
      retired = true;
    },
    failCommit: (e?: Service.MemoryServiceError) => {
      commitError = e;
    },
    seedItem: (item: ImportItem) => {
      items.set(item.sourceItemKey, item);
    },
    registration: () => registration,
    batch: () => batch,
  };
};
export const prepare = (h: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    const runtime = h.make();
    const discover = yield* runtime.run(
      {
        action: "discover",
        memorySpaceId: space,
        format: h.reader ? (h.registration()?.source.format ?? "codex") : "codex",
      },
      Effect.void,
    );
    assert.equal(discover.action, "discover");
    if (discover.action !== "discover") throw new Error("discover");
    const [source] = discover.sources;
    if (!source) throw new Error("discover found no source");
    const sourceId = source.sourceId;
    const preview = yield* runtime.run(
      { action: "preview", memorySpaceId: space, sourceId },
      Effect.void,
    );
    assert.equal(preview.action, "preview");
    if (preview.action !== "preview") throw new Error("preview");
    const input: Extract<M.MemoryImportProviderInput, { action: "apply" }> = {
      action: "apply",
      memorySpaceId: space,
      sourceId,
      sessionId: preview.sessionId,
      operationId: M.MemoryOperationId.make(uuid(50)),
      items: preview.items.flatMap((r) =>
        r.sourceFingerprint
          ? [
              {
                sourceItemKey: r.sourceItemKey,
                sourceFingerprint: r.sourceFingerprint,
                scope: { kind: "user" as const },
              },
            ]
          : [],
      ),
    };
    return { runtime, sourceId, preview, input };
  });
export const fixtureTest = <E>(
  f: (h: ReturnType<typeof harness>, snapshot: ImportSnapshot) => Effect.Effect<void, E, never>,
  profile: MemoryImportFixtureProfile = "codex-ad-hoc-v1",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* buildMemoryImportFixture(profile);
      yield* f(harness(fixture.snapshot), fixture.snapshot);
    }),
  );
export const issue = (e: unknown, expected: string) => {
  assert.instanceOf(e, M.MemoryImportRpcError);
  if (isImportError(e)) assert.equal(e.issue, expected);
};
