import { type MemoryHubSettingsSnapshot } from "./MemoryHubSettings.ts";
import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- historical admin request fixture.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as FileSystem from "effect/FileSystem";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import readyMigration from "../persistence/Migrations/087_MemoryLastReadySpace.ts";
import adminMigration from "../persistence/Migrations/088_MemoryHubAdministered.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import { memoryError } from "../mcp/toolkits/memory/handlers.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const hubEnv = M.EnvironmentId.make("hub");
const otherEnv = M.EnvironmentId.make("member");
const principal = (environmentId = hubEnv): M.MemoryHubPrincipal => ({
  memorySpaceId: space,
  environmentId,
  credentialVersion: 1,
  scopes: ["memory:sync"],
});
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
    Effect.andThen(readyMigration),
    Effect.andThen(adminMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
const core = Service.layer.pipe(
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
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(storeLayer))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
);
const configuration = Layer.succeed(Hub.MemoryHubConfiguration, {
  read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
});
const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provideMerge(Hub.activityLayer),
  Layer.provide(configuration),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${otherEnv},${"b".repeat(64)},1,'active',0)`;
});
const operation = (n = 10, env = hubEnv): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  originEnvironmentId: env,
  expectedHeads: [],
  revision: {
    memorySpaceId: space,
    memoryId,
    operationId: M.MemoryOperationId.make(id(n)),
    revisionId: M.MemoryRevisionId.make(id(n + 100)),
    parents: [],
    scope: { kind: "user" },
    payloadRef: M.MemoryRevisionId.make(id(n + 100)),
    assertionKind: "inference",
    createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
    provenance: { environmentId: env },
  },
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
});
const pushInput = (...operations: M.MemoryOperation[]): M.MemoryHubPushInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  operations,
});
const pullInput: M.MemoryHubPullInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  afterSequence: 0,
  limit: 100,
};
const conflict = Effect.gen(function* () {
  const hub = yield* Hub.MemoryHubService;
  const first = operation();
  yield* hub.push(pushInput(first), principal());
  const sibling = (n: number) => {
    const op = operation(n);
    return {
      ...op,
      expectedHeads: [first.revision.revisionId],
      revision: { ...op.revision, parents: [first.revision.revisionId] },
    };
  };
  yield* hub.push(pushInput(sibling(11), sibling(12)), principal());
  const store = yield* Store.MemoryStore;
  const current = yield* store.loadAggregate(space, memoryId);
  const claim: M.MemoryHubClaimInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId,
    holderEnvironmentId: hubEnv,
    conflictId: current.conflicts[0]!.conflictId,
    conflictHeadSet: current.heads,
    attemptId: M.MemoryOperationId.make(id(50)),
    frozenDefaultModelSelection: {
      instanceId: M.ProviderInstanceId.make("synthetic-provider"),
      model: "synthetic-model",
    },
  };
  return { hub, store, claim };
});

describe("MemoryHubService", () => {
  it.effect("replays one sequence, rejects changed digest and refuses revoked replay", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const first = yield* hub.push(pushInput(operation()), principal());
      assert.strictEqual(first.receipts[0]!.hubSequence, 1);
      assert.deepStrictEqual(yield* hub.push(pushInput(operation()), principal()), first);
      const changed = { ...operation(), payload: { ...operation().payload, text: "changed" } };
      const error = yield* hub.push(pushInput(changed), principal()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${hubEnv}`;
      assert.strictEqual(
        (yield* hub.push(pushInput(operation()), principal()).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        1,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("checks member origin, space and excess fields before any sequence", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      assert.strictEqual(
        (yield* hub
          .push({ ...pushInput(operation(10, otherEnv)), environmentId: otherEnv }, principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      assert.strictEqual(
        (yield* hub
          .pull({ ...pullInput, memorySpaceId: M.MemorySpaceId.make(id(999)) }, principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* hub
          .push(Object.assign(pushInput(operation()), { extra: true }), principal())
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("semantic refusal is sequenced metadata and a later sibling commits", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const bad = {
        ...operation(),
        payload: { ...operation().payload, text: "-----BEGIN PRIVATE KEY-----" },
      };
      const good = {
        ...operation(11),
        memoryId: M.MemoryId.make(id(3)),
        revision: { ...operation(11).revision, memoryId: M.MemoryId.make(id(3)) },
      };
      const result = yield* hub.push(pushInput(bad, good), principal());
      assert.deepStrictEqual(
        result.receipts.map((r) => r.outcome),
        ["rejected", "accepted"],
      );
      const page = yield* hub.pull(pullInput, principal());
      assert.deepStrictEqual(
        page.entries.map((e) => e.kind),
        ["metadata", "operation"],
      );
      assert.strictEqual(page.throughSequence, 2);
      assert.isFalse(JSON.stringify(page.entries[0]).includes("PRIVATE KEY"));
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("capacity failure returns null sequence and rolls back all canonical writes", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<${M.MEMORY_LOG_MAX_TAIL_ROWS}) INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) SELECT ${space},'tail-'||n,${memoryId},${hubEnv},${"c".repeat(64)},'{}',0 FROM rows`;
      const hub = yield* Hub.MemoryHubService;
      const result = yield* hub.push(pushInput(operation()), principal());
      assert.strictEqual(result.receipts[0]!.failureCode, "capacity_exceeded");
      assert.isNull(result.receipts[0]!.hubSequence);
      const store = yield* Store.MemoryStore;
      assert.isUndefined((yield* store.loadAggregate(space, memoryId)).item);
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
          .count,
        M.MEMORY_LOG_MAX_TAIL_ROWS,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("post-lock membership sees a revoke committed while push waited", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* store
        .transact(
          Effect.gen(function* () {
            yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${hubEnv}`;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const hub = yield* Hub.MemoryHubService;
      const waiting = yield* hub
        .push(pushInput(operation()), principal())
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      assert.strictEqual((yield* Fiber.join(waiting))._tag, "MemoryHubUnauthorizedError");
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("fixed watermark excludes later writes until the next pull", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.push(pushInput(operation()), principal());
      const page = yield* hub.pull({ ...pullInput, limit: 1 }, principal());
      const next = operation(11);
      yield* hub.push(
        pushInput({
          ...next,
          expectedHeads: [operation().revision.revisionId],
          revision: { ...next.revision, parents: [operation().revision.revisionId] },
        }),
        principal(),
      );
      const pinned = yield* hub.pull(
        { ...pullInput, afterSequence: page.throughSequence, highWatermark: page.highWatermark },
        principal(),
      );
      assert.strictEqual(pinned.entries.length, 0);
      assert.strictEqual(
        (yield* hub.pull({ ...pullInput, afterSequence: page.throughSequence }, principal()))
          .entries.length,
        1,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("only one claimant holds the fence; expiry takeover rejects stale release", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, claim } = yield* conflict;
      const first = yield* hub.claim(claim, principal());
      assert.deepStrictEqual(yield* hub.claim(claim, principal()), first);
      const other = {
        ...claim,
        holderEnvironmentId: otherEnv,
        attemptId: M.MemoryOperationId.make(id(51)),
      };
      assert.strictEqual(
        (yield* hub.claim(other, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* TestClock.adjust(M.MEMORY_LEASE_MS);
      const takeover = yield* hub.claim(other, principal(otherEnv));
      assert.isAbove(takeover.fencingToken, first.fencingToken);
      assert.strictEqual(
        (yield* hub
          .release(
            {
              protocolVersion: 1,
              memorySpaceId: space,
              memoryId,
              holderEnvironmentId: hubEnv,
              conflictId: claim.conflictId,
              attemptId: claim.attemptId,
              fencingToken: first.fencingToken,
            },
            principal(),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store.loadAggregate(space, memoryId)).fence!.activeLease!.holderEnvironmentId,
        otherEnv,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("renewal never extends the ten-minute attempt deadline", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, claim } = yield* conflict;
      const first = yield* hub.claim(claim, principal());
      const request: M.MemoryHubRenewInput = {
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId,
        holderEnvironmentId: hubEnv,
        conflictId: claim.conflictId,
        attemptId: claim.attemptId,
        fencingToken: first.fencingToken,
      };
      for (let n = 0; n < 9; n++) {
        yield* TestClock.adjust(60000);
        const next = yield* hub.renew(request, principal());
        assert.strictEqual(next.attemptDeadlineHubTime, first.attemptDeadlineHubTime);
      }
      yield* TestClock.adjust(60000);
      assert.strictEqual(
        (yield* hub.renew(request, principal()).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("join requires publication and checkpoint token expires without sliding", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const request: M.MemoryHubJoinInput = {
        protocolVersion: 1,
        memorySpaceId: null,
        environmentId: otherEnv,
      };
      assert.strictEqual(
        (yield* hub.join(request, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* (yield* Compactor.MemoryCompactor).compact(principal());
      const joined = yield* hub.join(request, principal(otherEnv));
      const pull = { ...pullInput, environmentId: otherEnv, snapshotToken: joined.snapshotToken };
      const first = yield* hub.pull(pull, principal(otherEnv));
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS - 1);
      assert.deepStrictEqual(yield* hub.pull(pull, principal(otherEnv)), first);
      yield* TestClock.adjust(1);
      assert.strictEqual(
        (yield* hub.pull(pull, principal(otherEnv)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

const thread: M.ScopedThreadRef = {
  environmentId: otherEnv,
  threadId: M.ThreadId.make("synthetic-thread"),
};
const watermark: M.MemorySourceWatermark = {
  fromEventId: M.EventId.make("synthetic-from"),
  toEventId: M.EventId.make("synthetic-to"),
  throughSequence: 8,
};
const messageId = M.MessageId.make("synthetic-message");
const sourceRequest: M.MemoryHubSourceReadRequestInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  memoryId,
  requestId: M.MemorySourceReadRequestId.make(id(300)),
  sourceThread: thread,
  sourceWatermark: watermark,
  messageIds: [messageId],
  limit: 10,
  authorizedScopes: ["memory:read", "orchestration:read"],
};
const sourceSeed = Effect.gen(function* () {
  yield* seed;
  const base = operation();
  yield* (yield* Hub.MemoryHubService).push(
    pushInput({
      ...base,
      revision: {
        ...base.revision,
        provenance: { environmentId: hubEnv, sourceThread: thread, sourceWatermark: watermark },
      },
      payload: {
        text: "synthetic linked summary",
        evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: [messageId] }],
        derivedFromMemoryRevisions: [],
      },
    }),
    principal(),
  );
});
const outcome: M.MemorySourceReadOutcome = {
  kind: "available",
  page: {
    sourceThread: thread,
    watermark,
    messages: [{ messageId, text: "synthetic original" }],
    nextCursor: null,
  },
};

describe("MemoryHubService source relay", () => {
  it.effect(
    "routes to the owner only and consumes the purgeable result without tail accumulation",
    () =>
      Effect.gen(function* () {
        yield* sourceSeed;
        const hub = yield* Hub.MemoryHubService;
        const first = yield* hub.requestSourceRead(sourceRequest, principal());
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(yield* hub.requestSourceRead(sourceRequest, principal()), first);
        const collect = { protocolVersion: 1 as const, memorySpaceId: space, limit: 32 };
        assert.strictEqual(
          (yield* hub.collectSourceReads(collect, principal())).requests.length,
          0,
        );
        assert.strictEqual(
          (yield* hub.collectSourceReads(collect, principal(otherEnv))).requests.length,
          1,
        );
        const response = {
          kind: "normal" as const,
          ownerPolicyEpoch: 1,
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: sourceRequest.requestId,
          outcome,
        };
        assert.strictEqual(
          (yield* hub.respondSourceRead(response, principal()).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        yield* hub.respondSourceRead(response, principal(otherEnv));
        const resultInput = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: sourceRequest.requestId,
        };
        assert.strictEqual(
          (yield* hub.resultSourceRead(resultInput, principal(otherEnv)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.deepStrictEqual(yield* hub.resultSourceRead(resultInput, principal()), {
          state: "completed",
          outcome,
        });
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
            .count,
          0,
        );
        assert.strictEqual((yield* hub.pull(pullInput, principal())).entries.length, 1);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("expires at the original 75-second deadline and rejects a late owner response", () =>
    Effect.gen(function* () {
      yield* sourceSeed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.requestSourceRead(sourceRequest, principal());
      yield* TestClock.adjust(74000);
      yield* hub.requestSourceRead(sourceRequest, principal());
      yield* TestClock.adjust(1000);
      assert.deepStrictEqual(
        yield* hub.resultSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId },
          principal(),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      assert.strictEqual(
        (yield* hub.respondSourceRead(
          {
            kind: "normal",
            ownerPolicyEpoch: 0,
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: sourceRequest.requestId,
            outcome,
          },
          principal(otherEnv),
        )).accepted,
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_source_reads WHERE locator_json!='{}'`)[0]!
          .count,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

const adminDependencies = Secrets.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-wp3-l2-admin-" })),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(core),
  Layer.provideMerge(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
);
const adminFixture = Effect.gen(function* () {
  yield* seed;
  const view = yield* Ref.make<MemoryHubSettingsSnapshot>({
    provenance: null,
    settings: { mode: "hub", memorySpaceId: space },
    version: 0,
  });
  const failApply = yield* Ref.make(false);
  const applied = yield* Ref.make(
    new Map<M.MemoryOperationId, { digest: string; result: { view: MemoryHubSettingsSnapshot } }>(),
  );
  const lock = yield* Semaphore.make(1);
  const backend: Hub.MemoryHubAdminSettings["Service"] = {
    withLock: (effect) => lock.withPermit(effect),
    read: Ref.get(view),
    readPublication: Effect.succeed({ state: "current" }),
    readPreviousHubRequestId: Effect.succeed(null),
    readPreviousHubSpace: Effect.succeed(space),
    apply: (record, permit) =>
      Effect.gen(function* () {
        yield* permit;
        if (yield* Ref.get(failApply)) return yield* new M.MemoryHubError({ code: "hub_disabled" });
        const saved = (yield* Ref.get(applied)).get(record.requestId);
        if (saved) {
          if (saved.digest !== record.requestDigest)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          return saved.result;
        }
        const current = yield* Ref.get(view);
        // This fixture is the settings CAS owner; SQL/admin service is real.
        if (current.version === record.expectedVersion) {
          const next = { ...current, version: current.version + 1 };
          yield* Ref.set(view, next);
          const result = { view: next };
          yield* Ref.update(applied, (entries) =>
            new Map(entries).set(record.requestId, { digest: record.requestDigest, result }),
          );
          return result;
        }
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      }),
  };
  const admin = yield* Hub.makeAdministrator.pipe(
    Effect.provideService(Hub.MemoryHubAdminSettings, backend),
  );
  return { admin, backend, failApply, view };
});
const provision: M.MemoryHubSettingsUpdateInput = {
  requestId: M.MemoryOperationId.make(id(400)),
  expectedVersion: 0,
  action: "provisionMember",
  environmentId: M.EnvironmentId.make("new-member"),
};

const encodeAdminRequest = Schema.encodeEffect(
  Schema.fromJsonString(M.MemoryHubSettingsUpdateInput),
);
const missingAcknowledgementCases = (
  ["configure", "rotateMemberCredential", "revokeMember"] as const
).flatMap((action) =>
  [
    { historical: false, retryFirst: false },
    { historical: true, retryFirst: false },
    { historical: true, retryFirst: true },
  ].map((entry) => ({ action, ...entry })),
);

describe("MemoryHubAdministrator", () => {
  it.effect("returns a fresh safe roster through provision, acknowledge, rotation and revoke", () =>
    Effect.gen(function* () {
      const { admin, backend } = yield* adminFixture;
      const store = yield* Store.MemoryStore;
      const read = () =>
        Effect.flatMap(backend.read, (snapshot) => Hub.readSettingsView(store, snapshot));
      const issued = yield* admin.update(provision, Effect.void);
      const target = (view: M.MemoryHubSettingsView) =>
        view.members.find((m) => m.environmentId === provision.environmentId)!;
      assert.strictEqual(target(issued.view).status, "pending_ack");
      assert.deepStrictEqual((yield* read()).members, issued.view.members);
      assert.deepStrictEqual(Object.keys(target(issued.view)).sort(), [
        "credentialVersion",
        "environmentId",
        "joinedAt",
        "status",
      ]);
      const ack = yield* admin.update(
        {
          action: "acknowledgeCredential",
          requestId: M.MemoryOperationId.make(id(491)),
          expectedVersion: 1,
          credentialRequestId: provision.requestId,
        },
        Effect.void,
      );
      assert.strictEqual(target(ack.view).status, "active");
      assert.deepStrictEqual((yield* read()).members, ack.view.members);
      const rotated = yield* admin.update(
        {
          action: "rotateMemberCredential",
          requestId: M.MemoryOperationId.make(id(492)),
          expectedVersion: 2,
          environmentId: provision.environmentId,
        },
        Effect.void,
      );
      assert.strictEqual(target(rotated.view).status, "pending_ack");
      assert.strictEqual(target(rotated.view).credentialVersion, 3);
      const revoked = yield* admin.update(
        {
          action: "revokeMember",
          requestId: M.MemoryOperationId.make(id(493)),
          expectedVersion: 3,
          environmentId: provision.environmentId,
        },
        Effect.void,
      );
      assert.isUndefined(target(revoked.view));
      assert.deepStrictEqual((yield* read()).members, revoked.view.members);
      const readded = yield* admin.update(
        { ...provision, requestId: M.MemoryOperationId.make(id(494)), expectedVersion: 4 },
        Effect.void,
      );
      assert.strictEqual(target(readded.view).status, "pending_ack");
      assert.strictEqual(target(readded.view).credentialVersion, 5);
      assert.deepStrictEqual(
        (yield* Hub.readSettingsView(store, {
          settings: { mode: "disabled" },
          version: 4,
        })).members,
        [],
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("reclaims removed devices at capacity without reviving their authority", () =>
    Effect.gen(function* () {
      const { admin, backend } = yield* adminFixture;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      let sequence = 10000;
      const update = Effect.fnUntraced(function* (
        action:
          | { action: "provisionMember" | "revokeMember"; environmentId: M.EnvironmentId }
          | { action: "acknowledgeCredential"; credentialRequestId: M.MemoryOperationId },
      ) {
        return yield* admin.update(
          {
            ...action,
            requestId: M.MemoryOperationId.make(id(sequence++)),
            expectedVersion: (yield* backend.read).version,
          },
          Effect.void,
        );
      });
      const first = yield* update({
        action: "provisionMember",
        environmentId: provision.environmentId,
      });
      const oldCredential = first.credential!;
      // Leave this install unacknowledged; revoke must supersede its ready receipt.
      const oldPrincipal = {
        ...principal(provision.environmentId),
        credentialVersion: oldCredential.credentialVersion,
      };
      const authority = {
        principal: oldPrincipal,
        now: Clock.currentTimeMillis,
        reauthorize: Effect.void,
      };
      const token = yield* store.transact(
        store.prepareHubCheckpointTx({
          authority,
          checkpointId: "reclaim-snapshot",
          snapshotToken: "reclaim-token",
          hubEnvironmentId: hubEnv,
        }),
      );
      const hub = yield* Hub.make.pipe(
        Effect.provide(Layer.merge(Hub.activityLayer, configuration)),
      );
      const { claim } = yield* conflict.pipe(Effect.provideService(Hub.MemoryHubService, hub));
      const ownedClaim = { ...claim, holderEnvironmentId: provision.environmentId };
      const lease = yield* hub.claim(ownedClaim, oldPrincipal);
      const devices = [otherEnv, provision.environmentId];
      for (let n = 0; n < M.MEMORY_HUB_MAX_MEMBERS - 3; n++) {
        const environmentId = M.EnvironmentId.make(`device-${n}`);
        const added = yield* update({ action: "provisionMember", environmentId });
        yield* update({
          action: "acknowledgeCredential",
          credentialRequestId: added.credential!.requestId,
        });
        devices.push(environmentId);
      }
      assert.strictEqual((yield* store.readHubMembers(space)).length, 128);
      for (const environmentId of devices) yield* update({ action: "revokeMember", environmentId });
      assert.deepStrictEqual(
        (yield* store.readHubMembers(space)).map((m) => m.environmentId),
        [hubEnv],
      );
      // Model r1's successful revoke receipt, which stopped at ready.
      yield* sql`UPDATE memory_outbox SET status='pending',terminal_at=NULL,
        admin_json=json_set(admin_json,'$.stage','ready')
        WHERE kind='admin' AND json_extract(admin_json,'$.action.action')='revokeMember'
          AND json_extract(admin_json,'$.action.environmentId')=${provision.environmentId}`;
      const added = yield* update({
        action: "provisionMember",
        environmentId: M.EnvironmentId.make("after-removals"),
      });
      assert.isNotNull(added.credential);
      assert.strictEqual(
        (yield* sql<{ status: string }>`SELECT status FROM memory_outbox
        WHERE kind='admin' AND json_extract(admin_json,'$.action.action')='revokeMember'
          AND json_extract(admin_json,'$.action.environmentId')=${provision.environmentId}`)[0]!
          .status,
        "completed",
      );
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_quota_counters
        WHERE space=${space} AND dimension='hub_member_version'`)[0]!.count,
        1,
      );
      assert.isUndefined(yield* store.readHubMember(space, provision.environmentId));
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${space}`)[0]!.count,
        2,
      );
      assert.isUndefined(
        yield* store.findHubMemberByCredential(
          NodeCrypto.createHash("sha256").update(oldCredential.credential).digest("hex"),
        ),
      );
      assert.strictEqual(
        (yield* store.transact(store.requireHubMemberTx(oldPrincipal)).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      const readded = yield* update({
        action: "provisionMember",
        environmentId: provision.environmentId,
      });
      const currentPrincipal = {
        ...oldPrincipal,
        credentialVersion: readded.credential!.credentialVersion,
      };
      assert.isAbove(currentPrincipal.credentialVersion, oldCredential.credentialVersion);
      assert.strictEqual(
        (yield* store.transact(store.requireHubMemberTx(oldPrincipal)).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      const renew = {
        protocolVersion: 1 as const,
        memorySpaceId: space,
        memoryId,
        holderEnvironmentId: provision.environmentId,
        conflictId: claim.conflictId,
        attemptId: claim.attemptId,
        fencingToken: lease.fencingToken,
      };
      assert.strictEqual(
        (yield* hub.renew(renew, oldPrincipal).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      assert.strictEqual(
        (yield* hub.renew(renew, currentPrincipal).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.readHubCheckpointPageTx({
              authority: { ...authority, principal: currentPrincipal },
              snapshotToken: token.snapshotToken,
              cursor: null,
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      const original = yield* store.transact(store.readHubAdminTx(oldCredential.requestId));
      assert.isDefined(original);
      assert.strictEqual(
        (yield* store
          .transact(
            store.activateHubMemberTx({
              requestId: oldCredential.requestId,
              requestDigest: original!.requestDigest,
              memorySpaceId: space,
              environmentId: provision.environmentId,
              expectedCredentialVersion: null,
              next: {
                credentialDigest: NodeCrypto.createHash("sha256")
                  .update(oldCredential.credential)
                  .digest("hex"),
              },
              now: 0,
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const replay = yield* admin
        .update({ ...provision, requestId: oldCredential.requestId }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "MemoryHubError");
      if (replay._tag === "MemoryHubError") assert.strictEqual(replay.code, "identity_mismatch");
      assert.strictEqual(
        (yield* store.readHubMember(space, provision.environmentId))!.credentialVersion,
        currentPrincipal.credentialVersion,
      );
    }).pipe(Effect.provide(adminDependencies)),
  );

  it.effect(
    "bounds source fences across 130 reclaimed requesters and settles delayed revokes",
    () =>
      Effect.gen(function* () {
        const { admin, backend } = yield* adminFixture;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        let sequence = 20000;
        const update = Effect.fnUntraced(function* (
          action: "provisionMember" | "revokeMember",
          environmentId: M.EnvironmentId,
        ) {
          return yield* admin.update(
            {
              requestId: M.MemoryOperationId.make(id(sequence++)),
              expectedVersion: (yield* backend.read).version,
              action,
              environmentId,
            },
            Effect.void,
          );
        });
        const authority = (environmentId = hubEnv, credentialVersion = 1): Store.HubAuthority => ({
          principal: { ...principal(environmentId), credentialVersion },
          now: Clock.currentTimeMillis,
          reauthorize: Effect.void,
        });
        const revoke = (requesterEnvironmentId: M.EnvironmentId) => ({
          protocolVersion: 1 as const,
          kind: "revoke" as const,
          memorySpaceId: space,
          requesterEnvironmentId,
          ownerPolicyEpoch: 2,
        });
        // Keep 127 rows live so every replacement exercises the real capacity path.
        for (let n = 0; n < 125; n++)
          yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at)
          VALUES (${space},${`filler-${n}`},${(n + 1000).toString(16).padStart(64, "0")},1,'active',0)`;
        let current = M.EnvironmentId.make("source-churn-0");
        let added = yield* update("provisionMember", current);
        const originalVersion = added.credential!.credentialVersion;
        const original = current;
        // A retired owner must lose its entire fence row as well.
        yield* store.transact(store.respondHubSourceReadTx(authority(otherEnv), revoke(hubEnv)));
        for (let n = 0; n < 130; n++) {
          const ack = yield* store.transact(
            store.respondHubSourceReadTx(authority(), revoke(current)),
          );
          assert.strictEqual(ack.kind, "revoke");
          yield* update("revokeMember", current);
          const retired = current;
          current = M.EnvironmentId.make(`source-churn-${n + 1}`);
          added = yield* update("provisionMember", current);
          assert.isUndefined(yield* store.readHubMember(space, retired));
          const delayed = yield* store.transact(
            store.respondHubSourceReadTx(authority(), revoke(retired)),
          );
          assert.deepStrictEqual(delayed, {
            kind: "revoke",
            accepted: true,
            ack: {
              memorySpaceId: space,
              ownerEnvironmentId: hubEnv,
              requesterEnvironmentId: retired,
              removalEpoch: 2,
              revokedThroughEpoch: 2,
            },
          });
          const fences = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM memory_import_keys
          WHERE space=${space} AND key_kind='hub_source_fences' AND key=${hubEnv}`;
          assert.deepStrictEqual(JSON.parse(fences[0]!.record_json), []);
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM memory_hub_members WHERE space=${space}`).length,
            128,
          );
        }
        yield* update("revokeMember", otherEnv);
        yield* update("revokeMember", current);
        const readded = yield* update("provisionMember", original);
        assert.isAbove(readded.credential!.credentialVersion, originalVersion);
        assert.strictEqual(
          (yield* store
            .transact(
              store.requireHubMemberTx({
                ...principal(original),
                credentialVersion: originalVersion,
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubUnauthorizedError",
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_import_keys
        WHERE space=${space} AND key_kind='hub_source_fences' AND key=${otherEnv}`).length,
          0,
        );
        // The re-enrolled pair gets a fresh fence; a delayed old response cannot
        // regain authority through a retired requester version (covered above).
        yield* store.transact(store.respondHubSourceReadTx(authority(), revoke(original)));
        const fences = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM memory_import_keys
        WHERE space=${space} AND key_kind='hub_source_fences' AND key=${hubEnv}`;
        assert.strictEqual(JSON.parse(fences[0]!.record_json).length, 1);
      }).pipe(Effect.provide(adminDependencies)),
  );

  it.effect.each(["active", "admin", "lease", "token"] as const)(
    "keeps unreclaimable %s rows and preserves typed capacity through the RPC codec",
    (blocker) =>
      Effect.gen(function* () {
        const { admin } = yield* adminFixture;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        for (let n = 2; n < M.MEMORY_HUB_MAX_MEMBERS; n++) {
          const environment = `retained-${n}`;
          yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${environment},${n.toString(16).padStart(64, "0")},500,${blocker === "active" ? "active" : "revoked"},0)`;
          if (blocker === "admin") {
            const requestId = M.MemoryOperationId.make(id(20000 + n));
            yield* store.transact(
              store.writeHubAdminTx({
                expectedStage: null,
                record: {
                  requestId,
                  requestDigest: "c".repeat(64),
                  expectedVersion: 0,
                  stage: "prepared",
                  memberVersion: null,
                  action: {
                    action: "provisionMember",
                    environmentId: M.EnvironmentId.make(environment),
                    requestId,
                    expectedVersion: 0,
                  },
                  secretName: "synthetic-key",
                  result: null,
                },
              }),
            );
          } else if (blocker === "lease") {
            yield* sql`INSERT INTO memory_hub_leases(space,memory_id,highest_token,lease_json) VALUES (${space},${id(30000 + n)},1,${JSON.stringify({ holderEnvironmentId: environment })})`;
          } else if (blocker === "token") {
            yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hub_checkpoint_token',${`token-${n}`},${space},${JSON.stringify({ retired: false, handle: { memberEnvironmentId: environment, expiresAt: 1000000 } })})`;
          }
        }
        const error = yield* admin.update(provision, Effect.void).pipe(Effect.flip);
        assert.strictEqual(error._tag, "MemoryCapacityError");
        if (error._tag !== "MemoryCapacityError") return;
        assert.deepStrictEqual(
          {
            dimension: error.dimension,
            current: error.current,
            limit: error.limit,
            reclaimable: error.reclaimable,
          },
          {
            dimension: "members",
            current: 128,
            limit: 128,
            reclaimable: 0,
          },
        );
        // ws.ts uses this mapper and this exact RPC error schema.
        const codec = Schema.fromJsonString(M.WsMemoryHubSettingsUpdateRpc.errorSchema);
        const wire = yield* Schema.encodeEffect(codec)(memoryError(error));
        const decoded = yield* Schema.decodeUnknownEffect(codec)(wire);
        assert.strictEqual(decoded._tag, "MemoryRpcError");
        if (decoded._tag === "MemoryRpcError")
          assert.deepStrictEqual(decoded.capacity, {
            code: "capacity_exceeded",
            dimension: "members",
            current: 128,
            limit: 128,
            reclaimable: 0,
          });
        assert.strictEqual(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${space}`)[0]!.count,
          128,
        );
      }).pipe(Effect.provide(adminDependencies)),
  );

  it.effect.each(missingAcknowledgementCases)(
    "missing acknowledgement before $action (historical=$historical, retryFirst=$retryFirst)",
    ({ action, historical, retryFirst }) =>
      Effect.gen(function* () {
        const { admin, backend, view } = yield* adminFixture;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const bad: M.MemoryHubSettingsUpdateInput = {
          requestId: M.MemoryOperationId.make(id(430)),
          expectedVersion: 0,
          action: "acknowledgeCredential",
          credentialRequestId: M.MemoryOperationId.make(id(431)),
        };
        if (historical) {
          const json = yield* encodeAdminRequest(bad);
          const record: Store.AdminRecord = {
            requestId: bad.requestId,
            requestDigest: NodeCrypto.createHash("sha256").update(json).digest("hex"),
            expectedVersion: 0,
            action: bad,
            stage: "prepared",
            memberVersion: null,
            secretName: null,
            result: null,
          };
          yield* store.transact(
            Effect.gen(function* () {
              yield* store.writeHubAdminTx({ record, expectedStage: null });
              yield* store.writeHubAdminTx({
                record: { ...record, stage: "activated" },
                expectedStage: "prepared",
              });
            }),
          );
        }
        const restarted = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        );
        if (retryFirst) {
          const error = yield* restarted.update(bad, Effect.void).pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryStoreConflict");
          if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "not_found");
          assert.strictEqual((yield* Ref.get(view)).version, 0);
          assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
        }
        // Recovery must also run when the first post-upgrade call is a normal admin action.
        if (!historical) {
          const before = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
          for (let retry = 0; retry < 2; retry++) {
            const error = yield* admin.update(bad, Effect.void).pipe(Effect.flip);
            assert.strictEqual(error._tag, "MemoryStoreConflict");
            if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "not_found");
          }
          assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, before);
          assert.strictEqual((yield* Ref.get(view)).version, 0);
        }
        const next: M.MemoryHubSettingsUpdateInput =
          action === "configure"
            ? {
                requestId: M.MemoryOperationId.make(id(432)),
                expectedVersion: 0,
                action,
                settings: { mode: "disabled" },
              }
            : {
                requestId: M.MemoryOperationId.make(id(432)),
                expectedVersion: 0,
                action,
                environmentId: otherEnv,
              };
        const result = yield* restarted.update(next, Effect.void);
        assert.strictEqual(result.view.version, 1);
        if (action === "rotateMemberCredential")
          assert.strictEqual(result.credential!.credentialVersion, 2);
        if (action === "revokeMember")
          assert.strictEqual((yield* store.readHubMember(space, otherEnv))!.status, "revoked");
        const after = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
        for (let retry = 0; retry < 2; retry++) {
          const error = yield* restarted.update(bad, Effect.void).pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryStoreConflict");
          if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "not_found");
        }
        assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, after);
        assert.strictEqual((yield* Ref.get(view)).version, 1);
        assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
        const failed = yield* store.transact(store.readHubAdminTx(bad.requestId));
        if (historical) {
          assert.strictEqual(failed!.stage, "acknowledged");
          assert.isNull(failed!.result);
          yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
          yield* store.transact(
            store.purgeHubTransientTx({
              memorySpaceId: space,
              now: yield* Clock.currentTimeMillis,
              limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
            }),
          );
          const replay = (yield* store.transact(store.readHubAdminTx(bad.requestId)))!;
          assert.isFalse("action" in replay);
          const error = yield* restarted.update(bad, Effect.void).pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryStoreConflict");
          if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "not_found");
          assert.strictEqual((yield* Ref.get(view)).version, 1);
        } else assert.isUndefined(failed);
      }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect(
    "rejects acknowledgement of a prepared credential or a non-credential action without writes",
    () =>
      Effect.gen(function* () {
        const { admin, backend } = yield* adminFixture;
        const store = yield* Store.MemoryStore;
        const secrets = yield* Secrets.ServerSecretStore;
        const failing = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, backend),
          Effect.provideService(Secrets.ServerSecretStore, {
            ...secrets,
            getOrCreateRandom: () =>
              Effect.fail(
                new Secrets.SecretStorePersistError({ resource: "synthetic", cause: undefined }),
              ),
          }),
        );
        yield* failing.update(provision, Effect.void).pipe(Effect.flip);
        const configured: M.MemoryHubSettingsUpdateInput = {
          requestId: M.MemoryOperationId.make(id(440)),
          expectedVersion: 0,
          action: "configure",
          settings: { mode: "disabled" },
        };
        yield* admin.update(configured, Effect.void);
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
        for (const credentialRequestId of [provision.requestId, configured.requestId]) {
          const error = yield* admin
            .update(
              {
                requestId: M.MemoryOperationId.make(id(441)),
                expectedVersion: 1,
                action: "acknowledgeCredential",
                credentialRequestId,
              },
              Effect.void,
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryStoreConflict");
          if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "not_found");
        }
        assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, before);
        assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
      }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect(
    "resumes after activation/settings failure using the same private secret and member version",
    () =>
      Effect.gen(function* () {
        const { admin, backend, failApply } = yield* adminFixture;
        yield* Ref.set(failApply, true);
        assert.strictEqual(
          (yield* admin.update(provision, Effect.void).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        const pending = yield* admin.pending(Effect.void);
        assert.strictEqual(pending[0]!.stage, "activated");
        assert.strictEqual(pending[0]!.memberVersion, 2);
        const secrets = yield* Secrets.ServerSecretStore;
        const staged = yield* secrets.get(pending[0]!.secretName!);
        assert.isTrue(Option.isSome(staged));
        yield* Ref.set(failApply, false);
        const restarted = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        );
        const result = yield* restarted.update(provision, Effect.void);
        assert.strictEqual(result.credential!.credentialVersion, 2);
        assert.strictEqual(
          result.credential!.credential,
          Buffer.from(Option.getOrThrow(staged)).toString("base64url"),
        );
        assert.deepStrictEqual(yield* restarted.update(provision, Effect.void), result);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          admin_json: string;
        }>`SELECT admin_json FROM memory_outbox WHERE kind='admin'`;
        assert.isFalse(rows[0]!.admin_json.includes(result.credential!.credential));
        assert.isFalse(rows[0]!.admin_json.includes('"credential":'));
      }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("a prepared rotation cannot supersede a completed competing rotation", () =>
    Effect.gen(function* () {
      const { admin, backend } = yield* adminFixture;
      const first = yield* admin.update(provision, Effect.void);
      const rotation: M.MemoryHubSettingsUpdateInput = {
        requestId: M.MemoryOperationId.make(id(410)),
        expectedVersion: 1,
        action: "rotateMemberCredential",
        environmentId: first.credential!.environmentId,
      };
      const secrets = yield* Secrets.ServerSecretStore;
      const failed = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        Effect.provideService(Secrets.ServerSecretStore, {
          ...secrets,
          getOrCreateRandom: () =>
            Effect.fail(
              new Secrets.SecretStorePersistError({ resource: "synthetic", cause: undefined }),
            ),
        }),
      );
      assert.strictEqual(
        (yield* failed.update(rotation, Effect.void).pipe(Effect.flip))._tag,
        "SecretStorePersistError",
      );
      assert.strictEqual(
        (yield* admin.pending(Effect.void)).find(
          (record) => record.requestId === rotation.requestId,
        )!.stage,
        "prepared",
      );
      const winner = yield* admin.update(
        { ...rotation, requestId: M.MemoryOperationId.make(id(411)) },
        Effect.void,
      );
      const store = yield* Store.MemoryStore;
      const member = yield* store.readHubMember(space, rotation.environmentId);
      const error = yield* admin.update(rotation, Effect.void).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "revision_changed");
      assert.deepStrictEqual(yield* store.readHubMember(space, rotation.environmentId), member);
      assert.strictEqual(member!.credentialVersion, winner.credential!.credentialVersion);
      yield* store.transact(
        store.requireHubMemberTx({
          ...principal(rotation.environmentId),
          credentialVersion: winner.credential!.credentialVersion,
        }),
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("an activated recovery blocks later transitions until its settings CAS finishes", () =>
    Effect.gen(function* () {
      const { admin, backend, failApply, view } = yield* adminFixture;
      yield* Ref.set(failApply, true);
      yield* admin.update(provision, Effect.void).pipe(Effect.flip);
      yield* Ref.set(failApply, false);
      const blocked = {
        ...provision,
        requestId: M.MemoryOperationId.make(id(412)),
        environmentId: M.EnvironmentId.make("other-new-member"),
      };
      assert.strictEqual(
        (yield* admin.update(blocked, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.transact(store.readHubAdminTx(blocked.requestId)));
      assert.isUndefined(yield* store.readHubMember(space, blocked.environmentId));
      const restarted = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
      );
      yield* restarted.update(provision, Effect.void);
      assert.strictEqual((yield* Ref.get(view)).version, 1);
      // A distinct request cannot replay another request's expectedVersion + 1.
      const original = (yield* store.transact(store.readHubAdminTx(provision.requestId)))!;
      if (!("action" in original)) throw new Error("expected uncompact admin fixture");
      assert.strictEqual(
        (yield* backend
          .apply({ ...original, requestId: blocked.requestId }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      yield* restarted.update({ ...blocked, expectedVersion: 1 }, Effect.void);
      assert.strictEqual((yield* Ref.get(view)).version, 2);
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("ready backlog permits new work but cannot hide an activated settings recovery", () =>
    Effect.gen(function* () {
      const { admin, backend, failApply, view } = yield* adminFixture;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.transact(
        Effect.gen(function* () {
          for (let n = 0; n <= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS; n++) {
            const requestId = M.MemoryOperationId.make(id(2000 + n));
            const record: Store.AdminRecord = {
              requestId,
              requestDigest: "d".repeat(64),
              expectedVersion: 0,
              action: {
                requestId,
                expectedVersion: 0,
                action: "configure",
                settings: { mode: "disabled" },
              },
              stage: "prepared",
              secretName: null,
              memberVersion: null,
              result: null,
            };
            yield* store.writeHubAdminTx({ record, expectedStage: null });
            yield* store.writeHubAdminTx({
              record: { ...record, stage: "activated" },
              expectedStage: "prepared",
            });
            const ready: Store.AdminRecord = {
              ...record,
              stage: "ready",
              result: { view: { provenance: null, settings: { mode: "disabled" }, version: 1 } },
            };
            yield* store.writeHubAdminTx({ record: ready, expectedStage: "activated" });
            if (n === 0)
              yield* store.writeHubAdminTx({
                record: { ...ready, stage: "acknowledged" },
                expectedStage: "ready",
              });
          }
        }),
      );
      assert.strictEqual(
        (yield* admin.pending(Effect.void)).length,
        M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
      );
      assert.strictEqual((yield* admin.update(provision, Effect.void)).view.version, 1);
      const recovery: M.MemoryHubSettingsUpdateInput = {
        ...provision,
        requestId: M.MemoryOperationId.make(id(4000)),
        expectedVersion: 1,
        environmentId: M.EnvironmentId.make("backlog-recovery"),
      };
      yield* Ref.set(failApply, true);
      yield* admin.update(recovery, Effect.void).pipe(Effect.flip);
      assert.isFalse(
        (yield* admin.pending(Effect.void)).some((r) => r.requestId === recovery.requestId),
      );
      assert.strictEqual(
        (yield* store.transact(store.readActivatedHubAdminTx()))!.requestId,
        recovery.requestId,
      );
      const later: M.MemoryHubSettingsUpdateInput = {
        ...recovery,
        requestId: M.MemoryOperationId.make(id(4001)),
        environmentId: M.EnvironmentId.make("after-backlog-recovery"),
      };
      const records = yield* sql`SELECT * FROM memory_outbox WHERE kind='admin' ORDER BY id`;
      const members =
        yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`;
      yield* Ref.set(failApply, false);
      assert.strictEqual(
        (yield* admin.update(later, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_outbox WHERE kind='admin' ORDER BY id`,
        records,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`,
        members,
      );
      const restarted = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
      );
      assert.strictEqual((yield* restarted.update(recovery, Effect.void)).view.version, 2);
      assert.strictEqual(
        (yield* restarted.update({ ...later, expectedVersion: 2 }, Effect.void)).view.version,
        3,
      );
      assert.strictEqual((yield* Ref.get(view)).version, 3);
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("request-id CAS replay recovers a settings commit before ready persistence", () =>
    Effect.gen(function* () {
      const { admin, backend, view } = yield* adminFixture;
      const store = yield* Store.MemoryStore;
      const failing = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        Effect.provideService(Store.MemoryStore, {
          ...store,
          writeHubAdminTx: (input) =>
            input.record.stage === "ready"
              ? Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" }))
              : store.writeHubAdminTx(input),
        }),
      );
      assert.strictEqual(
        (yield* failing.update(provision, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.strictEqual((yield* Ref.get(view)).version, 1);
      const blocked = {
        ...provision,
        requestId: M.MemoryOperationId.make(id(413)),
        expectedVersion: 1,
        environmentId: M.EnvironmentId.make("later-member"),
      };
      assert.strictEqual(
        (yield* admin.update(blocked, Effect.void).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const recovered = yield* admin.update(provision, Effect.void);
      assert.strictEqual(recovered.view.version, 1);
      assert.strictEqual(recovered.credential!.credentialVersion, 2);
      assert.strictEqual((yield* Ref.get(view)).version, 1);
      yield* admin.update(blocked, Effect.void);
      assert.strictEqual((yield* Ref.get(view)).version, 2);
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("acknowledgement erases outgoing bytes and replay cannot disclose them", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      const issued = yield* admin.update(provision, Effect.void);
      const record = (yield* admin.pending(Effect.void))[0]!;
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(401)),
          expectedVersion: 1,
          action: "acknowledgeCredential",
          credentialRequestId: provision.requestId,
        },
        Effect.void,
      );
      const secrets = yield* Secrets.ServerSecretStore;
      assert.isTrue(Option.isNone(yield* secrets.get(record.secretName!)));
      assert.isNull((yield* admin.update(provision, Effect.void)).credential);
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        (yield* store.readHubMember(space, issued.credential!.environmentId))!.credentialVersion,
        2,
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect(
    "acknowledged replay survives terminal compaction without restoring action or secret",
    () =>
      Effect.gen(function* () {
        const { admin, backend, view } = yield* adminFixture;
        yield* admin.update(provision, Effect.void);
        const acknowledge: M.MemoryHubSettingsUpdateInput = {
          requestId: M.MemoryOperationId.make(id(420)),
          expectedVersion: 1,
          action: "acknowledgeCredential",
          credentialRequestId: provision.requestId,
        };
        yield* admin.update(acknowledge, Effect.void);
        yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
        const store = yield* Store.MemoryStore;
        yield* store.transact(
          store.purgeHubTransientTx({
            memorySpaceId: space,
            now: yield* Clock.currentTimeMillis,
            limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
          }),
        );
        const replay = (yield* store.transact(store.readHubAdminTx(provision.requestId)))!;
        assert.strictEqual(replay.stage, "acknowledged");
        assert.isFalse("action" in replay);
        const restarted = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Hub.MemoryHubAdminSettings, backend),
        );
        assert.isNull((yield* restarted.update(provision, Effect.void)).credential);
        assert.isNull(
          (yield* restarted.update(
            { ...acknowledge, requestId: M.MemoryOperationId.make(id(421)), expectedVersion: 2 },
            Effect.void,
          )).credential,
        );
        assert.strictEqual((yield* Ref.get(view)).version, 3);
        assert.isNull((yield* restarted.update(acknowledge, Effect.void)).credential);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_outbox WHERE id=${`admin:${provision.requestId}`}`)
            .length,
          0,
        );
        assert.deepStrictEqual(
          yield* store.transact(store.readHubAdminTx(provision.requestId)),
          replay,
        );
        const secrets = yield* Secrets.ServerSecretStore;
        assert.isTrue(Option.isNone(yield* secrets.get(replay.secretName!)));
      }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("denied owner permission creates neither secret nor member/admin record", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      assert.strictEqual(
        (yield* admin
          .update(provision, Effect.fail(new M.MemoryHubForbiddenError({})))
          .pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      assert.deepStrictEqual(yield* admin.pending(Effect.void), []);
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.readHubMember(space, M.EnvironmentId.make("new-member")));
    }).pipe(Effect.provide(adminDependencies)),
  );
  it.effect("rotate/revoke invalidate old principals and changed request bytes cannot replay", () =>
    Effect.gen(function* () {
      const { admin } = yield* adminFixture;
      const first = yield* admin.update(provision, Effect.void);
      assert.strictEqual(
        (yield* admin
          .update({ ...provision, environmentId: M.EnvironmentId.make("changed") }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      const env = first.credential!.environmentId;
      const rotated = yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(402)),
          expectedVersion: 1,
          action: "rotateMemberCredential",
          environmentId: env,
        },
        Effect.void,
      );
      assert.strictEqual(rotated.credential!.credentialVersion, 3);
      assert.notStrictEqual(rotated.credential!.credential, first.credential!.credential);
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        (yield* store.transact(store.requireHubMemberTx(principal(env))).pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(403)),
          expectedVersion: 2,
          action: "revokeMember",
          environmentId: env,
        },
        Effect.void,
      );
      assert.strictEqual((yield* store.readHubMember(space, env))!.status, "revoked");
      assert.strictEqual(
        (yield* admin.update(provision, Effect.void).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
    }).pipe(Effect.provide(adminDependencies)),
  );
});

const resolutionSubmission = Effect.gen(function* () {
  const { hub, store, claim } = yield* conflict;
  const lease = yield* hub.claim(claim, principal());
  const base = operation(80);
  const resolutionId = M.MemoryResolutionId.make(id(81));
  const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
    ...base,
    kind: "resolve",
    expectedHeads: claim.conflictHeadSet,
    payload: { ...base.payload, derivedFromMemoryRevisions: claim.conflictHeadSet },
    revision: { ...base.revision, parents: claim.conflictHeadSet },
    conflictId: claim.conflictId,
    fencingToken: lease.fencingToken,
    resolution: {
      resolutionId,
      memorySpaceId: space,
      memoryId,
      inputRevisionIds: claim.conflictHeadSet,
      inputPayloadRefs: claim.conflictHeadSet,
      judgmentRef: resolutionId,
      requestedModelSelection: claim.frozenDefaultModelSelection,
      effectiveProvider: M.ProviderDriverKind.make("codex"),
      effectiveModel: "synthetic-model",
      resolvingEnvironmentId: hubEnv,
      fencingToken: lease.fencingToken,
      resultRevisionId: base.revision.revisionId,
      appliedAtUtc: M.MemoryUtcTimestamp.make("2000-01-01T00:00:00.000Z"),
      revertDeadlineUtc: M.MemoryUtcTimestamp.make("2000-01-02T00:00:00.000Z"),
    },
    resolutionPayload: { resolutionId, judgment: "synthetic judgment" },
  };
  const request: M.MemoryHubApplyResolutionInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    holderEnvironmentId: hubEnv,
    attemptId: claim.attemptId,
    operation: op,
  };
  return { hub, store, claim, lease, op, request };
});

describe("MemoryHubService resolution approval", () => {
  it.effect(
    "uses post-lock hub time rather than operation timestamps and preserves approval on replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const { hub, store, request, op } = yield* resolutionSubmission;
        const now = yield* Clock.currentTimeMillis;
        const approved = yield* hub.applyResolution(request, principal());
        assert.strictEqual(approved.outcome, "accepted");
        assert.strictEqual(
          approved.resolutionApproval!.appliedAtUtc,
          DateTime.formatIso(DateTime.makeUnsafe(now)),
        );
        assert.strictEqual(
          Date.parse(approved.resolutionApproval!.revertDeadlineUtc),
          now + 2592000000,
        );
        const aggregate = yield* store.loadAggregate(space, memoryId);
        assert.deepStrictEqual(aggregate.heads, [op.revision.revisionId]);
        assert.strictEqual(
          aggregate.resolutions[0]!.appliedAtUtc,
          DateTime.formatIso(DateTime.makeUnsafe(now)),
        );
        yield* TestClock.adjust(M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS);
        assert.deepStrictEqual(yield* hub.applyResolution(request, principal()), approved);
        assert.deepStrictEqual((yield* hub.push(pushInput(op), principal())).receipts, [approved]);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("ordinary push cannot admit a new resolution", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, op } = yield* resolutionSubmission;
      const refusal = (yield* hub.push(pushInput(op), principal())).receipts[0]!;
      assert.strictEqual(refusal.outcome, "rejected");
      assert.strictEqual(refusal.failureCode, "lease_required");
      assert.isNotNull(refusal.hubSequence);
      assert.isFalse(
        (yield* store.loadAggregate(space, memoryId)).heads.includes(op.revision.revisionId),
      );
      const page = yield* hub.pull(pullInput, principal());
      assert.strictEqual(page.entries.at(-1)!.kind, "metadata");
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("SQL lock wait crossing expiry cannot approve a stale resolution", () =>
    Effect.gen(function* () {
      yield* seed;
      const { hub, store, request } = yield* resolutionSubmission;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* store
        .transact(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const waiting = yield* hub.applyResolution(request, principal()).pipe(Effect.forkChild);
      yield* TestClock.adjust(M.MEMORY_LEASE_MS);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      const refusal = yield* Fiber.join(waiting);
      assert.strictEqual(refusal.failureCode, "lease_expired");
      assert.isUndefined(refusal.resolutionApproval);
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).resolutions.length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("forget immediately invalidates pending source relay", () =>
    Effect.gen(function* () {
      yield* sourceSeed;
      const hub = yield* Hub.MemoryHubService;
      yield* hub.requestSourceRead(sourceRequest, principal());
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const operationId = M.MemoryOperationId.make(id(600));
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId,
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
        },
        Effect.void,
      );
      const op = (yield* store.readWorkOperation(`sync:${space}:${operationId}`))!;
      yield* hub.push(pushInput(op), principal());
      const response = yield* hub
        .respondSourceRead(
          {
            kind: "normal",
            ownerPolicyEpoch: 0,
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: sourceRequest.requestId,
            outcome,
          },
          principal(otherEnv),
        )
        .pipe(Effect.flip);
      assert.strictEqual(response._tag, "MemoryHubError");
      if (response._tag === "MemoryHubError")
        assert.strictEqual(response.code, "identity_mismatch");
      assert.deepStrictEqual(
        yield* hub.resultSourceRead(
          { protocolVersion: 1, memorySpaceId: space, requestId: sourceRequest.requestId },
          principal(),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
          .count,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

const bootstrapDependencies = Layer.mergeAll(Store.layer, Settings.layer).pipe(
  Layer.provideMerge(Persistence.layerConfig),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-wp3-l6-bootstrap-" })),
  Layer.provideMerge(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const encodeHubAdminRequest = Schema.encodeEffect(
  Schema.fromJsonString(M.MemoryHubSettingsUpdateInput),
);
const firstHub: M.MemoryHubSettingsUpdateInput = {
  requestId: M.MemoryOperationId.make(id(9000)),
  expectedVersion: 0,
  action: "configure",
  settings: { mode: "hub", memorySpaceId: null },
};
const assertPublished = Effect.fnUntraced(function* (memorySpaceId: M.MemorySpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.MemoryStore;
  const member = yield* store.readHubMember(memorySpaceId, hubEnv);
  assert.strictEqual(member?.status, "active");
  assert.strictEqual(member?.credentialVersion, 1);
  const rows = yield* sql<{
    published: number;
    checkpoint_id: string;
  }>`SELECT published,checkpoint_id FROM memory_compaction_state WHERE space=${memorySpaceId}`;
  assert.strictEqual(rows[0]?.published, 1);
  assert.strictEqual(rows[0]?.checkpoint_id, `initial-${firstHub.requestId}`);
});
const readySpace = (result: M.MemoryHubSettingsUpdateResult) => {
  assert.strictEqual(result.view.settings.mode, "hub");
  if (result.view.settings.mode !== "hub" || result.view.settings.memorySpaceId === null)
    throw new Error("fixture requires initialized hub");
  assert.isNull(result.credential);
  return result.view.settings.memorySpaceId;
};

it.effect(
  "first null-space hub configure publishes self membership before ready and lost-response replay",
  () =>
    Effect.gen(function* () {
      const admin = yield* Hub.makeAdministrator;
      const first = yield* admin.update(firstHub, Effect.void);
      const allocated = readySpace(first);
      yield* assertPublished(allocated);
      assert.deepStrictEqual(yield* admin.update(firstHub, Effect.void), first);
      const pending = yield* admin.pending(Effect.void);
      const record = pending.find((item) => item.requestId === firstHub.requestId)!;
      if (record.action.action !== "configure") throw new Error("expected configure");
      assert.deepStrictEqual(yield* admin.update(record.action, Effect.void), first);
      assert.deepStrictEqual(
        (yield* (yield* Settings.ServerSettingsService).getSettings).memoryHub,
        first.view.settings,
      );
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const persisted = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.isFalse(Object.hasOwn(persisted.memoryHub, "secretName"));
      assert.strictEqual(first.view.version, 1);
    }).pipe(Effect.provide(bootstrapDependencies)),
);

const interruptedHub = Effect.gen(function* () {
  const backend = yield* Hub.MemoryHubAdminSettings;
  const reachedApply = yield* Deferred.make<void>();
  const block = yield* Deferred.make<void>();
  const admin = yield* Hub.makeAdministrator.pipe(
    Effect.provideService(Hub.MemoryHubAdminSettings, {
      ...backend,
      apply: () =>
        Deferred.succeed(reachedApply, undefined).pipe(
          Effect.andThen(Deferred.await(block)),
          Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "storage_failed" }))),
        ),
    }),
  );
  const fiber = yield* admin.update(firstHub, Effect.void).pipe(Effect.forkChild);
  yield* Deferred.await(reachedApply);
  yield* Fiber.interrupt(fiber);
  const store = yield* Store.MemoryStore;
  const record = yield* store.transact(store.readHubAdminTx(firstHub.requestId));
  assert.strictEqual(record?.stage, "activated");
  assert.strictEqual((yield* backend.read).settings.mode, "disabled");
  return record!;
});

it.effect(
  "interruption after activation before apply restarts from the same durable space and secret reference",
  () =>
    Effect.gen(function* () {
      const record = yield* interruptedHub;
      assert.isTrue("action" in record);
      if (!("action" in record) || record.action.action !== "configure")
        throw new Error("expected configure");
      const action = record.action;
      const recovered = yield* Effect.gen(function* () {
        const admin = yield* Hub.makeAdministrator;
        return yield* admin.update(action, Effect.void);
      }).pipe(
        Effect.provide(
          Layer.fresh(
            Layer.mergeAll(Store.layer, Settings.layer).pipe(
              Layer.provideMerge(Persistence.layerConfig),
            ),
          ),
        ),
      );
      const allocated = readySpace(recovered);
      yield* assertPublished(allocated);
      const store = yield* Store.MemoryStore;
      const ready = yield* store.transact(store.readHubAdminTx(firstHub.requestId));
      assert.strictEqual(ready?.secretName, record.secretName);
      assert.strictEqual(ready?.memberVersion, record.memberVersion);
      const admin = yield* Hub.makeAdministrator;
      assert.deepStrictEqual(yield* admin.update(firstHub, Effect.void), recovered);
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect(
  "superseding CAS retires activation and disable configure restart reuse its publication",
  () =>
    Effect.gen(function* () {
      const original = yield* interruptedHub;
      if (
        !("action" in original) ||
        original.action.action !== "configure" ||
        original.action.settings.mode !== "hub" ||
        original.action.settings.memorySpaceId === null
      )
        throw new Error("expected resolved space");
      const allocated = original.action.settings.memorySpaceId;
      const transitions = yield* Settings.MemoryHubSettingsTransitions;
      yield* transitions.applyMemoryHubTransition(
        {
          requestId: M.MemoryOperationId.make(id(9100)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      const admin = yield* Hub.makeAdministrator;
      const conflict = yield* admin.update(firstHub, Effect.void).pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "MemoryHubError");
      if (conflict._tag === "MemoryHubError") assert.strictEqual(conflict.code, "revision_changed");
      const denied = yield* admin
        .update(
          {
            requestId: M.MemoryOperationId.make(id(9110)),
            expectedVersion: 1,
            action: "configure",
            settings: { mode: "disabled" },
          },
          Effect.fail(new M.MemoryHubForbiddenError({})),
        )
        .pipe(Effect.flip);
      assert.strictEqual(denied._tag, "MemoryHubForbiddenError");
      const stale = yield* admin
        .update(
          {
            requestId: M.MemoryOperationId.make(id(9110)),
            expectedVersion: 0,
            action: "configure",
            settings: { mode: "disabled" },
          },
          Effect.void,
        )
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "MemoryStoreConflict");
      assert.strictEqual(
        (yield* (yield* Store.MemoryStore).transact(
          (yield* Store.MemoryStore).readHubAdminTx(firstHub.requestId),
        ))?.stage,
        "activated",
      );
      const disabled = yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(9101)),
          expectedVersion: 1,
          action: "configure",
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      assert.strictEqual(disabled.view.version, 2);
      const store = yield* Store.MemoryStore;
      const retired = yield* store.transact(store.readHubAdminTx(firstHub.requestId));
      assert.strictEqual(retired?.stage, "acknowledged");
      assert.isNull(retired?.result);
      if (!retired || !("action" in retired)) throw new Error("missing immutable receipt");
      assert.deepStrictEqual(retired.action, original.action);
      assert.strictEqual(retired.requestDigest, original.requestDigest);
      const replay = yield* admin.update(firstHub, Effect.void).pipe(Effect.flip);
      assert.strictEqual(replay._tag, "MemoryHubError");
      if (replay._tag === "MemoryHubError") assert.strictEqual(replay.code, "revision_changed");
      const reused = yield* admin
        .update({ ...firstHub, expectedVersion: 2 }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(reused._tag, "MemoryStoreConflict");
      if (reused._tag === "MemoryStoreConflict")
        assert.strictEqual(reused.code, "operation_id_reused");
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: allocated,
          now: (yield* Clock.currentTimeMillis) + M.MEMORY_LOG_RETENTION_MS + 1,
          limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
        }),
      );
      const compacted = yield* store.transact(store.readHubAdminTx(firstHub.requestId));
      assert.isFalse(compacted && "action" in compacted);
      yield* Effect.gen(function* () {
        const secretStore = yield* Secrets.ServerSecretStore;
        const restarted = yield* Hub.makeAdministrator.pipe(
          Effect.provideService(Secrets.ServerSecretStore, {
            ...secretStore,
            getOrCreateRandom: () =>
              Effect.die(new Error("existing self must not read credential bytes")),
          }),
        );
        assert.deepStrictEqual(
          yield* restarted.update(firstHub, Effect.void).pipe(Effect.flip),
          replay,
        );
        const configured = yield* restarted.update(
          {
            ...firstHub,
            requestId: M.MemoryOperationId.make(id(9102)),
            expectedVersion: 2,
          },
          Effect.void,
        );
        assert.strictEqual(readySpace(configured), allocated);
        yield* assertPublished(allocated);
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_compaction_state`)[0]
            ?.count,
          1,
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(
            Layer.mergeAll(Store.layer, Settings.layer).pipe(
              Layer.provideMerge(Persistence.layerConfig),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect(
  "superseding configure survives interrupted successor preparation without losing the activated space",
  () =>
    Effect.gen(function* () {
      const original = yield* interruptedHub;
      if (
        !("action" in original) ||
        original.action.action !== "configure" ||
        original.action.settings.mode !== "hub"
      )
        throw new Error("expected configure");
      const store = yield* Store.MemoryStore;
      yield* (yield* Settings.MemoryHubSettingsTransitions).applyMemoryHubTransition(
        {
          requestId: M.MemoryOperationId.make(id(9120)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      const successor: M.MemoryHubSettingsUpdateInput = {
        ...firstHub,
        requestId: M.MemoryOperationId.make(id(9121)),
        expectedVersion: 1,
      };
      const interrupted = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Store.MemoryStore, {
          ...store,
          writeHubAdminTx: (input) =>
            input.record.requestId === successor.requestId && input.expectedStage === null
              ? Effect.interrupt
              : store.writeHubAdminTx(input),
        }),
      );
      const stopped = yield* interrupted.update(successor, Effect.void).pipe(Effect.exit);
      assert.strictEqual(stopped._tag, "Failure");
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(firstHub.requestId)))?.stage,
        "activated",
      );
      assert.isUndefined(yield* store.transact(store.readHubAdminTx(successor.requestId)));
      const admin = yield* Hub.makeAdministrator;
      const result = yield* admin.update(successor, Effect.void);
      assert.strictEqual(readySpace(result), original.action.settings.memorySpaceId);
      yield* assertPublished(readySpace(result));
      const failure = yield* admin.update(firstHub, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryHubError");
      if (failure._tag === "MemoryHubError") assert.strictEqual(failure.code, "revision_changed");
    }).pipe(Effect.provide(bootstrapDependencies)),
);

const successorStops = [
  "before prepared commit",
  "after prepared commit",
  "after activation before settings apply",
  "after settings apply",
] as const;

it.effect.each(
  (["hub", "disabled"] as const).flatMap((mode) => [
    ...successorStops.map((stop) => ({ mode, stop, legacyMode: null, retryLegacy: false })),
    ...(["hub", "hub-no-reference", "disabled", "member"] as const).flatMap((legacyMode) =>
      [false, true].map((retryLegacy) => ({
        mode,
        stop: "after prepared commit" as const,
        legacyMode,
        retryLegacy,
      })),
    ),
  ]),
)(
  "successor binding survives $mode $stop and a fresh request after restart (legacy=$legacyMode retry=$retryLegacy)",
  ({ mode, stop, legacyMode, retryLegacy }) =>
    Effect.gen(function* () {
      const original = yield* interruptedHub;
      if (
        !("action" in original) ||
        original.action.action !== "configure" ||
        original.action.settings.mode !== "hub" ||
        original.action.settings.memorySpaceId === null
      )
        throw new Error("expected published original binding");
      const allocated = original.action.settings.memorySpaceId;
      yield* (yield* Settings.MemoryHubSettingsTransitions).applyMemoryHubTransition(
        {
          requestId: M.MemoryOperationId.make(id(9200)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      const successor: M.MemoryHubSettingsUpdateInput = {
        requestId: M.MemoryOperationId.make(id(9201)),
        expectedVersion: 1,
        action: "configure",
        settings: mode === "hub" ? { mode, memorySpaceId: null } : { mode },
      };
      const store = yield* Store.MemoryStore;
      const legacyRetry: M.MemoryHubSettingsUpdateInput = {
        ...firstHub,
        requestId: M.MemoryOperationId.make(id(30000)),
        expectedVersion: 1,
        settings:
          legacyMode === "disabled"
            ? { mode: "disabled" }
            : legacyMode === "member"
              ? {
                  mode: "member",
                  endpoint: "https://synthetic.invalid",
                  hubEnvironmentId: otherEnv,
                  secretName: "synthetic-member-reference",
                  memorySpaceId: allocated,
                }
              : {
                  mode: "hub",
                  memorySpaceId: legacyMode === "hub-no-reference" ? allocated : null,
                },
      };
      if (legacyMode !== null) {
        // R already exists outside the bounded sweep before B is prepared. These
        // are historical intents, not new requests or rewritten persisted actions.
        yield* store.transact(
          Effect.gen(function* () {
            for (const n of [...Array.from({ length: 256 }, (_, index) => 10000 + index), 30000]) {
              const action: M.MemoryHubSettingsUpdateInput =
                n === 30000
                  ? legacyRetry
                  : { ...firstHub, requestId: M.MemoryOperationId.make(id(n)), expectedVersion: 1 };
              yield* store.writeHubAdminTx({
                record: {
                  requestId: action.requestId,
                  requestDigest: NodeCrypto.createHash("sha256")
                    .update(yield* encodeHubAdminRequest(action))
                    .digest("hex"),
                  expectedVersion: 1,
                  action,
                  stage: "prepared",
                  memberVersion: null,
                  result: null,
                  secretName: null,
                },
                expectedStage: null,
              });
            }
          }),
        );
      }
      const backend = yield* Hub.MemoryHubAdminSettings;
      const prepared = yield* Ref.make(false);
      const interrupted = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Store.MemoryStore, {
          ...store,
          writeHubAdminTx: (input) => {
            if (input.record.requestId !== successor.requestId || input.expectedStage !== null)
              return store.writeHubAdminTx(input);
            if (stop === "before prepared commit") return Effect.interrupt;
            return store.writeHubAdminTx(input).pipe(Effect.tap(() => Ref.set(prepared, true)));
          },
          // Interrupt only AFTER the real transaction returned: retirement and the
          // successor intent have committed, unlike a write-boundary rollback test.
          transact: (effect) =>
            store
              .transact(effect)
              .pipe(
                Effect.tap(() =>
                  Ref.get(prepared).pipe(
                    Effect.flatMap((saved) =>
                      saved && stop === "after prepared commit" ? Effect.interrupt : Effect.void,
                    ),
                  ),
                ),
              ),
        }),
        Effect.provideService(Hub.MemoryHubAdminSettings, {
          ...backend,
          apply: (record, permit) => {
            if (record.requestId !== successor.requestId) return backend.apply(record, permit);
            if (stop === "after activation before settings apply") return Effect.interrupt;
            return backend
              .apply(record, permit)
              .pipe(
                Effect.tap(() =>
                  stop === "after settings apply" ? Effect.interrupt : Effect.void,
                ),
              );
          },
        }),
      );
      const stopped = yield* interrupted.update(successor, Effect.void).pipe(Effect.exit);
      assert.strictEqual(stopped._tag, "Failure");
      const saved = yield* store.transact(store.readHubAdminTx(successor.requestId));
      const retired = yield* store.transact(store.readHubAdminTx(firstHub.requestId));
      assert.strictEqual(
        retired?.stage,
        stop === "before prepared commit" ? "activated" : "acknowledged",
      );
      if (stop === "before prepared commit") assert.isUndefined(saved);
      else {
        assert.strictEqual(
          saved?.stage,
          stop === "after prepared commit" ? "prepared" : "activated",
        );
        assert.strictEqual(saved?.secretName, original.secretName);
      }
      const legacyBefore =
        legacyMode === null
          ? undefined
          : yield* store.transact(store.readHubAdminTx(legacyRetry.requestId));
      if (legacyMode !== null) assert.strictEqual(legacyBefore?.stage, "prepared");
      const legacyResult = retryLegacy
        ? yield* (yield* Hub.makeAdministrator).update(legacyRetry, Effect.void).pipe(Effect.result)
        : null;
      const successorAfterRetry = yield* store.transact(store.readHubAdminTx(successor.requestId));
      const legacyAfterRetry =
        legacyMode === null
          ? undefined
          : yield* store.transact(store.readHubAdminTx(legacyRetry.requestId));
      yield* Effect.gen(function* () {
        const restartedStore = yield* Store.MemoryStore;
        const admin = yield* Hub.makeAdministrator;
        const settings = yield* Hub.MemoryHubAdminSettings;
        const next: M.MemoryHubSettingsUpdateInput = {
          ...firstHub,
          requestId: M.MemoryOperationId.make(id(9202)),
          expectedVersion: (yield* settings.read).version,
        };
        if (stop === "after prepared commit") {
          const denied = yield* admin
            .update(next, Effect.fail(new M.MemoryHubForbiddenError({})))
            .pipe(Effect.flip);
          assert.strictEqual(denied._tag, "MemoryHubForbiddenError");
          const stale = yield* admin
            .update({ ...next, expectedVersion: 0 }, Effect.void)
            .pipe(Effect.flip);
          assert.strictEqual(stale._tag, "MemoryStoreConflict");
          assert.deepStrictEqual(
            yield* restartedStore.transact(restartedStore.readHubAdminTx(successor.requestId)),
            successorAfterRetry,
          );
        }
        // An activated operation can still own the current revision. Reconcile its
        // successful CAS first, then retry C against the newly observed revision.
        if (stop === "after activation before settings apply") {
          const changed = yield* admin.update(next, Effect.void).pipe(Effect.flip);
          assert.strictEqual(changed._tag, "MemoryStoreConflict");
          if (changed._tag === "MemoryStoreConflict")
            assert.strictEqual(changed.code, "revision_changed");
          assert.strictEqual((yield* settings.read).version, 2);
        }
        const result = yield* admin.update(
          { ...next, expectedVersion: (yield* settings.read).version },
          Effect.void,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_compaction_state WHERE published=1`)[0]?.count,
          1,
        );
        assert.strictEqual(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_members`)[0]
            ?.count,
          1,
        );
        if (legacyMode !== null) assert.deepStrictEqual(successorAfterRetry, saved);
        if (retryLegacy) {
          assert.strictEqual(legacyResult?._tag, "Failure");
          if (legacyResult?._tag === "Failure") {
            assert.strictEqual(legacyResult.failure._tag, "MemoryHubError");
            if (legacyResult.failure._tag === "MemoryHubError")
              assert.strictEqual(legacyResult.failure.code, "bootstrap_required");
          }
          assert.deepStrictEqual(legacyAfterRetry, legacyBefore);
        }
        assert.strictEqual(readySpace(result), allocated);
        yield* assertPublished(allocated);
        const disabled = yield* admin.update(
          {
            requestId: M.MemoryOperationId.make(id(9203)),
            expectedVersion: result.view.version,
            action: "configure",
            settings: { mode: "disabled" },
          },
          Effect.void,
        );
        yield* Effect.gen(function* () {
          const reenabled = yield* (yield* Hub.makeAdministrator).update(
            {
              ...firstHub,
              requestId: M.MemoryOperationId.make(id(9204)),
              expectedVersion: disabled.view.version,
            },
            Effect.void,
          );
          assert.strictEqual(readySpace(reenabled), allocated);
          yield* assertPublished(allocated);
          const freshSql = yield* SqlClient.SqlClient;
          assert.strictEqual(
            (yield* freshSql<{
              count: number;
            }>`SELECT count(*) AS count FROM memory_compaction_state WHERE published=1`)[0]?.count,
            1,
          );
          assert.strictEqual(
            (yield* freshSql<{
              count: number;
            }>`SELECT count(*) AS count FROM memory_hub_members`)[0]?.count,
            1,
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(
              Layer.mergeAll(Store.layer, Settings.layer).pipe(
                Layer.provideMerge(Persistence.layerConfig),
              ),
            ),
          ),
        );
        if (saved && "action" in saved) {
          const terminal = yield* restartedStore.transact(
            restartedStore.readHubAdminTx(successor.requestId),
          );
          assert.strictEqual(terminal?.secretName, saved.secretName);
          if (stop === "after prepared commit") {
            assert.strictEqual(terminal?.stage, "acknowledged");
            assert.isNull(terminal?.result);
            assert.isTrue(terminal && "action" in terminal);
            if (terminal && "action" in terminal) {
              assert.deepStrictEqual(terminal.action, saved.action);
              assert.strictEqual(terminal.requestDigest, saved.requestDigest);
            }
            const refusal = yield* admin.update(successor, Effect.void).pipe(Effect.flip);
            assert.strictEqual(refusal._tag, "MemoryHubError");
            if (refusal._tag === "MemoryHubError")
              assert.strictEqual(refusal.code, "revision_changed");
            assert.isFalse(
              (yield* admin.pending(Effect.void)).some(
                (item) => item.requestId === successor.requestId,
              ),
            );
          } else assert.strictEqual(terminal?.stage, "ready");
        }
      }).pipe(
        Effect.provide(
          Layer.fresh(
            Layer.mergeAll(Store.layer, Settings.layer).pipe(
              Layer.provideMerge(Persistence.layerConfig),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect(
  "a full pending sweep refuses unproven null-space allocation without retiring pointers",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.transact(
        Effect.gen(function* () {
          for (let index = 0; index < M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS; index++) {
            const action: M.MemoryHubSettingsUpdateInput = {
              ...firstHub,
              requestId: M.MemoryOperationId.make(id(10000 + index)),
            };
            const requestDigest = NodeCrypto.createHash("sha256")
              .update(yield* encodeHubAdminRequest(action))
              .digest("hex");
            yield* store.writeHubAdminTx({
              record: {
                requestId: action.requestId,
                requestDigest,
                expectedVersion: 0,
                action,
                stage: "prepared",
                memberVersion: null,
                result: null,
                secretName: null,
              },
              expectedStage: null,
            });
          }
        }),
      );
      const admin = yield* Hub.makeAdministrator;
      const error = yield* admin.update(firstHub, Effect.void).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryStoreConflict");
      if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "revision_changed");
      assert.isUndefined(yield* store.transact(store.readHubAdminTx(firstHub.requestId)));
      const pending = yield* admin.pending(Effect.void);
      assert.strictEqual(pending.length, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isTrue(pending.every((item) => item.stage === "prepared"));
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_members`)[0]?.count,
        0,
      );
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_compaction_state`)[0]
          ?.count,
        0,
      );
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect.each(["prepared", "activated"] as const)(
  "superseding CAS retires legacy null-space %s without publication",
  (stage) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const digest = NodeCrypto.createHash("sha256")
        .update(yield* encodeHubAdminRequest(firstHub))
        .digest("hex");
      const prepared = yield* store.transact(
        store.writeHubAdminTx({
          record: {
            requestId: firstHub.requestId,
            requestDigest: digest,
            expectedVersion: 0,
            action: firstHub,
            stage: "prepared",
            secretName: null,
            result: null,
            memberVersion: null,
          },
          expectedStage: null,
        }),
      );
      if (stage === "activated")
        yield* store.transact(
          store.writeHubAdminTx({
            record: { ...prepared, stage },
            expectedStage: "prepared",
          }),
        );
      const admin = yield* Hub.makeAdministrator;
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(9103)),
          expectedVersion: 0,
          action: "configure",
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      const failure = yield* admin.update(firstHub, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryHubError");
      if (failure._tag === "MemoryHubError") assert.strictEqual(failure.code, "revision_changed");
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(firstHub.requestId)))?.stage,
        "acknowledged",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_compaction_state`)[0]
          ?.count,
        0,
      );
      const configured = yield* admin.update(
        { ...firstHub, requestId: M.MemoryOperationId.make(id(9104)), expectedVersion: 1 },
        Effect.void,
      );
      assert.strictEqual(configured.view.version, 2);
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect(
  "disable then null-space re-enable after settings restart reuses the published space and member",
  () =>
    Effect.gen(function* () {
      const admin = yield* Hub.makeAdministrator;
      const first = yield* admin.update(firstHub, Effect.void);
      const allocated = readySpace(first);
      yield* admin.update(
        {
          requestId: M.MemoryOperationId.make(id(9002)),
          expectedVersion: 1,
          action: "configure",
          settings: { mode: "disabled" },
        },
        Effect.void,
      );
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        standingInstructions: "preserve marker",
      });
      const reenabled = yield* Effect.gen(function* () {
        const restarted = yield* Hub.makeAdministrator;
        return yield* restarted.update(
          { ...firstHub, requestId: M.MemoryOperationId.make(id(9003)), expectedVersion: 2 },
          Effect.void,
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(
            Layer.mergeAll(Store.layer, Settings.layer).pipe(
              Layer.provideMerge(Persistence.layerConfig),
            ),
          ),
        ),
      );
      assert.strictEqual(readySpace(reenabled), allocated);
      assert.strictEqual(reenabled.view.version, 3);
      yield* assertPublished(allocated);
    }).pipe(Effect.provide(bootstrapDependencies)),
);

it.effect(
  "first hub activation denied by the post-lock permit leaves prepared settings disabled",
  () =>
    Effect.gen(function* () {
      const secrets = yield* Secrets.ServerSecretStore;
      let authorized = true;
      const admin = yield* Hub.makeAdministrator.pipe(
        Effect.provideService(Secrets.ServerSecretStore, {
          ...secrets,
          getOrCreateRandom: (name, size) =>
            secrets.getOrCreateRandom(name, size).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  authorized = false;
                }),
              ),
            ),
        }),
      );
      const permit = Effect.suspend(() =>
        authorized ? Effect.void : Effect.fail(new M.MemoryHubForbiddenError({})),
      );
      const failure = yield* admin.update(firstHub, permit).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryHubForbiddenError");
      const backend = yield* Hub.MemoryHubAdminSettings;
      assert.strictEqual((yield* backend.read).settings.mode, "disabled");
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_members`)[0]!.count,
        0,
      );
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_compaction_state WHERE published=1`)[0]!.count,
        0,
      );
    }).pipe(Effect.provide(bootstrapDependencies)),
);
