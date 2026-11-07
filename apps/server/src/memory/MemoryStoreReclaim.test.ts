import { assert, describe, it } from "@effect/vitest";
import type { MemoryStoreReclaimResult } from "./MemoryStoreReclaim.ts";
import { memoryFailure } from "../mcp/toolkits/memory/handlers.ts";
import { storedEnvelope } from "../mcp/toolkits/agentSurface/dispatchEnvelope.ts";
import { declaredFailureLiteral } from "@goat/contracts/agentSurface/envelope";
import * as Fiber from "effect/Fiber";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import searchMigration from "../persistence/Migrations/090_MemorySearchCounters.ts";
import * as Service from "./MemoryService.ts";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/088_Memory.ts";
import hubMigration from "../persistence/Migrations/089_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/092_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/093_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/105_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/094_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/095_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/096_MemoryRevertResults.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const operation = (n = 3) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: id(n + 10),
      operationId: id(n),
      parents: [],
      scope: { kind: "user" },
      payloadRef: id(n + 10),
      assertionKind: "inference",
      provenance: { environmentId: env },
      createdAtUtc: now,
    },
    payload: { text: "synthetic searchable text", evidence: [], derivedFromMemoryRevisions: [] },
  });
const decision = (op = operation()): Store.MemoryDecision => ({
  operation: op,
  operationDigest: hash,
  admission: Store.localIntent,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    pendingSync: true,
    revisionId: op.kind === "forget" ? null : op.revision.revisionId,
    outcome: op.kind === "forget" ? "deleted" : "accepted",
  },
  ...(op.kind !== "forget"
    ? {
        item: {
          memorySpaceId: space,
          memoryId: memory,
          status: "active",
          scope: op.revision.scope,
          revision: op.revision,
          payload: op.payload,
          pendingSync: true,
          localAvailability: {
            exposure: "visible",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        } as M.MemoryItem,
      }
    : {}),
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
    Effect.andThen(searchMigration),
  ),
).pipe(Layer.provideMerge(database));
const live = Store.layer.pipe(Layer.provideMerge(setup));
const services = Quota.layer.pipe(Layer.provideMerge(live));
const memoryService = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(services),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(env) }),
  ),
);

const sample = (day: number, value = day): M.MemoryStorageSample => {
  const instant = DateTime.add(DateTime.makeUnsafe(now), { days: day });
  return {
    measuredAtUtc: DateTime.formatIso(instant),
    utcDay: DateTime.formatIsoDateUtc(instant),
    status: "partial",
    memoryLogicalBytes: value,
    memoryAllocatedBytes: null,
    ftsAllocatedBytes: null,
    dbFileBytes: value + 100,
    walBytes: null,
    freelistBytes: 0,
    tables: [],
  };
};

const encodeFailure = Schema.encodeSync(M.OrchestratorMcpFailure);
const decodeFailure = Schema.decodeUnknownSync(M.OrchestratorMcpFailure);
const isMcpFailure = Schema.is(M.OrchestratorMcpFailure);
// The failure's fields as of 0102c72f82, before classification existed: what older builds decode.
const decodeBaseFailure = Schema.decodeUnknownSync(
  Schema.TaggedStruct("OrchestratorMcpFailure", {
    code: M.OrchestratorMcpFailureCode,
    message: Schema.String,
    reason: Schema.optionalKey(M.OrchestratorMcpFailureReason),
    mayHaveStarted: Schema.optionalKey(Schema.Boolean),
    remoteCode: Schema.optionalKey(Schema.String),
    reconcile: Schema.optionalKey(Schema.String),
  }),
);
const storeFull = () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      memoryFailure("goat_memory_remember")(
        new Store.MemoryCapacityError({
          dimension: "live_payload_bytes",
          current: 117_727_232,
          limit: M.MEMORY_STORE_BUDGET_BYTES,
          budget: "store",
          reclaim: "completed",
          reclaimable: 0,
        }),
      ),
    );
    assert.isTrue(isMcpFailure(failure), "a store-full refusal is an OrchestratorMcpFailure");
    if (!isMcpFailure(failure)) return yield* Effect.die("unexpected refusal shape");
    return failure;
  });
const fixtureNow = Date.parse(now);
const overBudgetSample = () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.recordSample(env, {
      ...sample(0),
      memoryAllocatedBytes: M.MEMORY_STORE_BUDGET_BYTES,
    });
    yield* TestClock.setTime(fixtureNow + 1000);
  });
const stubReclaim = (result: MemoryStoreReclaimResult) => {
  let calls = 0;
  const service = Quota.MemoryStoreReclaim.of({
    reclaim: () => Effect.sync(() => (calls++, result)),
    bindHub: () => Effect.void,
  });
  return { service, calls: () => calls };
};
const writeOnce = Effect.gen(function* () {
  const quota = yield* Quota.MemoryQuotaService;
  const op = operation();
  return yield* Quota.withStoreReclaim(env)(quota.commit(decision(op), env, Effect.void));
});

describe("MemoryStoreReclaim", () => {
  it.effect("writes that arrive while a reclaim runs share it instead of compacting again", () =>
    Effect.gen(function* () {
      const reclaim = yield* Quota.MemoryStoreReclaim;
      let compactions = 0;
      yield* reclaim.bindHub(
        Option.some({
          memorySpaceId: space,
          reclaim: Effect.sync(() => compactions++).pipe(Effect.andThen(Effect.sleep(1000))),
        }),
      );
      const both = yield* Effect.all([reclaim.reclaim(env), reclaim.reclaim(env)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(1000);
      yield* Fiber.join(both);
      assert.strictEqual(compactions, 1);
    }).pipe(Effect.provide(services)),
  );
  it.effect("an interrupted reclaim releases its waiters and the next reclaim runs", () =>
    Effect.gen(function* () {
      const reclaim = yield* Quota.MemoryStoreReclaim;
      yield* reclaim.bindHub(Option.some({ memorySpaceId: space, reclaim: Effect.sleep(60_000) }));
      const owner = yield* reclaim.reclaim(env).pipe(Effect.forkChild);
      const waiter = yield* reclaim.reclaim(env).pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* Fiber.interrupt(owner);
      assert.deepInclude(yield* Fiber.join(waiter), { outcome: "failed" });
      let compactions = 0;
      yield* reclaim.bindHub(
        Option.some({ memorySpaceId: space, reclaim: Effect.sync(() => compactions++) }),
      );
      yield* reclaim.reclaim(env);
      assert.strictEqual(compactions, 1);
    }).pipe(Effect.provide(services)),
  );
  it.effect("a reclaim requested after the previous one finished runs again", () =>
    Effect.gen(function* () {
      const reclaim = yield* Quota.MemoryStoreReclaim;
      let compactions = 0;
      yield* reclaim.bindHub(
        Option.some({ memorySpaceId: space, reclaim: Effect.sync(() => compactions++) }),
      );
      yield* reclaim.reclaim(env);
      yield* reclaim.reclaim(env);
      assert.strictEqual(compactions, 2);
    }).pipe(Effect.provide(services)),
  );
  it.effect("the store-full refusal decodes with the failure fields older builds know", () =>
    Effect.gen(function* () {
      const wire = encodeFailure(yield* storeFull());
      assert.deepInclude(decodeBaseFailure(wire), { code: "capacity_exceeded" });
      assert.deepInclude(decodeFailure(wire), {
        code: "capacity_exceeded",
        classification: "memory_store_full",
      });
    }),
  );
  it.effect("goat_call and stored results both answer a store-full refusal as not retryable", () =>
    Effect.gen(function* () {
      const failure = yield* storeFull();
      const result = {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(encodeFailure(failure)) }],
      };
      // The live dispatch reclassifies by the captured error; a stored write by its literal.
      for (const captured of [failure, declaredFailureLiteral(failure)]) {
        const envelope = storedEnvelope("goat_memory_remember", {}, "write", result, captured);
        assert.deepInclude(envelope, { status: "error" });
        if (envelope.status !== "error") continue;
        assert.deepInclude(envelope.error, {
          code: "failed_precondition",
          reason: "memory_store_full",
          retryable: false,
        });
        assert.include(envelope.error.message, M.MEMORY_STORE_FULL_LABEL);
      }
    }),
  );
  it.effect("remember on an over-budget store is saved after one automatic reclaim", () =>
    Effect.gen(function* () {
      yield* overBudgetSample();
      const service = yield* Service.MemoryService;
      const saved = yield* service.remember(
        { memorySpaceId: space, scope: "user", text: "prefers concise reports" },
        Effect.void,
      );
      assert.strictEqual(saved.receipt.outcome, "accepted");
    }).pipe(Effect.provide(memoryService)),
  );
  it.effect("an over-budget local write is saved after one automatic reclaim", () =>
    Effect.gen(function* () {
      yield* overBudgetSample();
      const receipt = yield* writeOnce;
      assert.strictEqual(receipt.receipt.outcome, "accepted");
    }).pipe(Effect.provide(services)),
  );
  it.effect("a full store with nothing to reclaim refuses once and names the outcome", () => {
    const stub = stubReclaim({
      outcome: "unsupported",
      eligibleLogicalBytes: 0,
      nextEligibleAtMs: null,
    });
    return Effect.gen(function* () {
      yield* overBudgetSample();
      const refusal = yield* Effect.flip(writeOnce);
      assert.deepInclude(refusal, {
        _tag: "MemoryCapacityError",
        budget: "store",
        reclaim: "unsupported",
        reclaimable: 0,
      });
      assert.strictEqual(stub.calls(), 1);
    }).pipe(
      Effect.provideService(Quota.MemoryStoreReclaim, stub.service),
      Effect.provide(services),
    );
  });
  it.effect("a store refusal inside a caller transaction is not retried", () => {
    const stub = stubReclaim({
      outcome: "completed",
      eligibleLogicalBytes: 0,
      nextEligibleAtMs: null,
    });
    return Effect.gen(function* () {
      yield* overBudgetSample();
      const store = yield* Store.MemoryStore;
      const refusal = yield* Effect.flip(store.transact(writeOnce));
      assert.deepInclude(refusal, { _tag: "MemoryCapacityError", budget: "store" });
      assert.strictEqual(stub.calls(), 0);
    }).pipe(
      Effect.provideService(Quota.MemoryStoreReclaim, stub.service),
      Effect.provide(services),
    );
  });
  it.effect("only a completed or unsupported reclaim with nothing left is final for agents", () =>
    Effect.gen(function* () {
      const refusal = (fields: Partial<Store.MemoryCapacityError>) =>
        new Store.MemoryCapacityError({
          dimension: "live_payload_bytes",
          current: 117_727_232,
          limit: M.MEMORY_STORE_BUDGET_BYTES,
          budget: "store",
          reclaimable: 0,
          largestTables: [{ table: "memory_outbox", bytes: 25_948_160 }],
          ...fields,
        });
      const final = yield* Effect.flip(
        memoryFailure("goat_memory_remember")(refusal({ reclaim: "completed" })),
      );
      assert.deepInclude(final, {
        _tag: "OrchestratorMcpFailure",
        code: "capacity_exceeded",
        classification: "memory_store_full",
      });
      assert.include(final.message, M.MEMORY_STORE_FULL_LABEL);
      assert.include(final.message, "memory_outbox");
      const member = yield* Effect.flip(
        memoryFailure("goat_memory_remember")(refusal({ reclaim: "unsupported" })),
      );
      assert.include(member.message, "does not host the memory hub");
      const later = yield* Effect.flip(
        memoryFailure("goat_memory_remember")(
          refusal({ reclaim: "completed", nextEligibleAtMs: fixtureNow }),
        ),
      );
      assert.include(later.message, DateTime.formatIso(DateTime.makeUnsafe(fixtureNow)));
      for (const transient of [
        { reclaim: "failed" as const },
        { reclaim: "completed" as const, reclaimable: 4096 },
      ]) {
        const retryable = yield* Effect.flip(
          memoryFailure("goat_memory_remember")(refusal(transient)),
        );
        assert.deepInclude(retryable, { _tag: "MemoryRpcError", code: "capacity_exceeded" });
      }
    }),
  );
});
