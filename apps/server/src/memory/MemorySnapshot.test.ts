import * as Settings from "../serverSettings.ts";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Renderer from "@goat/provider-core/server/memoryContext";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Snapshot from "./MemorySnapshot.ts";

const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryContextSnapshot));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const environmentId = M.EnvironmentId.make("fixture");
const threadId = M.ThreadId.make("thread");
const runId = M.RunId.make("run");
const projectId = M.ProjectId.make("project");
const input = (n: number, scope: M.MemoryScope = { kind: "user" }): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId: M.MemoryId.make(id(n)),
  operationId: M.MemoryOperationId.make(id(n + 10000)),
  expectedHeads: [],
  scope,
  assertionKind: "inference",
  payload: { text: "synthetic & <memory> " + n, evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
const fixture = (
  options: {
    repository?: M.RepositoryIdentity;
    foreignRevisionSpace?: M.MemorySpaceId;
  } = {},
) => {
  let pageReads = 0;
  const pageScopes: M.MemoryScope["kind"][] = [];
  let policy: Snapshot.MemorySnapshotPolicy = { grant: "read", policyEpoch: 1 };
  let active = true;
  let currentRunId = runId;
  let ready = true;
  // The projection boundary supplies only the shell fields read by this service.
  const shell = {
    id: threadId,
    projectId,
    activeRunId: runId,
    activityRunStatus: "running",
  } as M.OrchestrationV2ThreadShell;
  const database = Layer.effectDiscard(runMigrations()).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const store = Store.layer.pipe(Layer.provideMerge(database));
  const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const serviceBase = Service.layer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provideMerge(identity),
    Layer.provide(
      Layer.mock(Repository.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(options.repository ?? null),
      }),
    ),
  );
  const service = Layer.effect(
    Service.MemoryService,
    Effect.gen(function* () {
      const original = yield* Service.MemoryService;
      return Service.MemoryService.of({
        ...original,
        readContextRevisions: (space, ids, permit) =>
          original
            .readContextRevisions(space, ids, permit)
            .pipe(
              Effect.map((page) =>
                options.foreignRevisionSpace
                  ? { ...page, memorySpaceId: options.foreignRevisionSpace }
                  : page,
              ),
            ),
        readContextCandidates: (input, permit) =>
          Effect.sync(() => {
            pageReads++;
            pageScopes.push(input.scope?.kind ?? "user");
          }).pipe(Effect.andThen(original.readContextCandidates(input, permit))),
      });
    }),
  ).pipe(Layer.provideMerge(serviceBase));
  const live = Snapshot.layer.pipe(
    Layer.provideMerge(service),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getThreadShell: (requested) =>
          Effect.sync(() =>
            active ? { ...shell, id: requested, activeRunId: currentRunId } : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.sync(() => ({
            memorySpaceId: space,
            bootstrap: ready ? ("ready" as const) : ("staging" as const),
          })),
      }),
    ),
  );
  return {
    live,
    pageReads: () => pageReads,
    pageScopes,
    policy: () => policy,
    currentPolicy: Effect.sync(() => policy),
    setPolicy: (value: Snapshot.MemorySnapshotPolicy) => {
      policy = value;
    },
    end: () => {
      active = false;
    },
    changeRun: () => {
      currentRunId = M.RunId.make("replacement-run");
    },
    unready: () => {
      ready = false;
    },
  };
};
const project = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'synthetic','/synthetic','[]','2026-10-15','2026-10-15')`;
});
it.effect(
  "selects thread/project/user in order, restores only survivors, and fences policy/identity/TTL",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* project;
      yield* store.putProjectBinding(
        {
          memorySpaceId: space,
          project: { environmentId, projectId },
          projectKey: { kind: "explicit", sharedProjectId: "shared" },
          repositoryKey: null,
          version: 1,
        },
        null,
        0,
      );
      const threadScope: M.MemoryScope = { kind: "thread", thread: { environmentId, threadId } };
      const projectScope: M.MemoryScope = {
        kind: "project",
        projectKey: { kind: "explicit", sharedProjectId: "shared" },
      };
      for (const [n, scope] of [
        [2, { kind: "user" }],
        [3, projectScope],
        [4, threadScope],
      ] as const)
        yield* service.upsert(input(n, scope), Effect.void);
      const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      assert.isDefined(selected);
      assert.deepStrictEqual(
        selected!.items.map((i) => i.scope.kind),
        ["thread", "project", "user"],
      );
      assert.isTrue(Renderer.memoryContextFits(selected!.renderedText));
      assert.include(selected!.renderedText, "&amp;");
      yield* service.upsert(input(5), Effect.void);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId: M.MemoryId.make(id(3)),
          operationId: M.MemoryOperationId.make(id(500)),
          expectedHeads: [],
        },
        Effect.void,
      );
      const restored = yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.deepStrictEqual(
        restored!.items.map((i) => i.memoryId),
        [id(4), id(2)],
      );
      assert.isUndefined(
        yield* snapshot.revalidate(
          selected!,
          { threadId: M.ThreadId.make("foreign"), runId },
          f.currentPolicy,
        ),
      );
      const second = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      f.setPolicy({ grant: "read_write", policyEpoch: 2 });
      assert.isUndefined(yield* snapshot.revalidate(second!, { threadId, runId }, f.currentPolicy));
      f.setPolicy({ grant: "none", policyEpoch: 2 });
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
      f.setPolicy({ grant: "read", policyEpoch: 3 });
      const third = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS);
      assert.isUndefined(yield* snapshot.revalidate(third!, { threadId, runId }, f.currentPolicy));
      const fourth = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      yield* snapshot.invalidate(threadId);
      assert.isUndefined(yield* snapshot.revalidate(fourth!, { threadId, runId }, f.currentPolicy));
      f.end();
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    }).pipe(Effect.provide(f.live));
  },
);
it.effect(
  "omits unready space and discards selection when a concurrent committed write changes its watermark",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      let calls = 0;
      const reached = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(reached);
          yield* service.upsert(input(3), Effect.void);
          yield* Deferred.succeed(committed, undefined);
        }),
      );
      const currentPolicy = Effect.gen(function* () {
        if (++calls === 3) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(committed);
        }
        return f.policy();
      });
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), currentPolicy));
      yield* Fiber.join(writer);
      f.unready();
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    }).pipe(Effect.provide(f.live));
  },
);

it.effect("bounds excluded candidates to ten pages and follows the unfiltered row cursor", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    yield* project;
    yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
      SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),'{"kind":"user"}','user','[]','blocked',0,
      json_object('memorySpaceId',${space},'memoryId',printf('00000000-0000-4000-8000-%012d',n),'status','blocked','scope',json('{"kind":"user"}'),'failureCode','scanner_pending','pendingSync',json('false'),'localAvailability',json('{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}')),
      '{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}' FROM ids`;
    yield* service.upsert(input(2000), Effect.void);
    const omitted = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.deepStrictEqual(omitted!.items, []);
    assert.include(
      Renderer.memoryContextText(omitted),
      'More GOAT memories exist than fit here; use goat_call {path:"memory.search"} or goat_call {path:"memory.read"} to find them.',
    );
    assert.strictEqual(f.pageReads(), 10);
    // Remove all but a single excluded first page; the next page must reach the eligible row.
    yield* sql`DELETE FROM memory_items WHERE space=${space} AND memory_id>${id(100)} AND memory_id<${id(2000)}`;
    const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.memoryId),
      [id(2000)],
    );
  }).pipe(Effect.provide(f.live));
});
it.effect(
  "reserves user pages after a large project and preserves the omission notice on restore",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshots = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* project;
      const projectKey: M.MemoryProjectKey = { kind: "explicit", sharedProjectId: "shared" };
      yield* store.putProjectBinding(
        {
          memorySpaceId: space,
          project: { environmentId, projectId },
          projectKey,
          repositoryKey: null,
          version: 1,
        },
        null,
        0,
      );
      const scope: M.MemoryScope = { kind: "project", projectKey };
      const scopeJson = JSON.stringify(scope);
      // Real examined-row cursors must advance even across pages with no eligible candidates.
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
      SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),${scopeJson},'explicit:shared','[]','blocked',0,
      json_object('memorySpaceId',${space},'memoryId',printf('00000000-0000-4000-8000-%012d',n),'status','blocked','scope',json(${scopeJson}),'failureCode','scanner_pending','pendingSync',json('false'),'localAvailability',json('{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}')),
      '{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}' FROM ids`;
      yield* service.upsert(input(2000), Effect.void);
      const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      assert.deepStrictEqual(
        selected!.items.map((i) => i.memoryId),
        [id(2000)],
      );
      assert.deepStrictEqual(f.pageScopes, [
        "thread",
        "project",
        "project",
        "project",
        "project",
        "user",
      ]);
      const framed = Renderer.memoryContextText(selected);
      assert.include(
        framed,
        'More GOAT memories exist than fit here; use goat_call {path:"memory.search"} or goat_call {path:"memory.read"} to find them.',
      );
      const restored = yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.strictEqual(Renderer.memoryContextText(restored), framed);
      const repeated = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      assert.deepStrictEqual(repeated, selected);
      for (const [scope, scopeKey, offset] of [
        [{ kind: "thread", thread: { environmentId, threadId } }, "thread:7:fixture:thread", 3000],
        [{ kind: "user" }, "user", 5000],
      ] as const) {
        const scopeJson = JSON.stringify(scope);
        yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
        INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
        SELECT ${space},printf('00000000-0000-4000-8000-%012d',n+${offset}),${scopeJson},${scopeKey},'[]','blocked',0,
        json_object('memorySpaceId',${space},'memoryId',printf('00000000-0000-4000-8000-%012d',n+${offset}),'status','blocked','scope',json(${scopeJson}),'failureCode','scanner_pending','pendingSync',json('false'),'localAvailability',json('{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}')),
        '{"exposure":"held","reasons":[],"deferred":[],"cleanupPending":false}' FROM ids`;
      }
      const before = f.pageReads();
      const saturated = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      assert.deepStrictEqual(
        saturated!.items.map((i) => i.memoryId),
        [id(2000)],
      );
      assert.deepStrictEqual(f.pageScopes.slice(before), [
        "thread",
        "thread",
        "thread",
        "project",
        "project",
        "project",
        "user",
        "user",
        "user",
        "user",
      ]);
    }).pipe(Effect.provide(f.live));
  },
);
it.effect("skips whole oversized facts and packs Unicode within both native-frame limits", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    for (let n = 2; n < 10; n++) {
      const value = input(n);
      yield* service.upsert(
        { ...value, payload: { ...value.payload, text: "synthetic word ".repeat(650) } },
        Effect.void,
      );
    }
    const value = input(10);
    const text = "🙂".repeat(1000) + "synthetic word ".repeat(180);
    yield* service.upsert({ ...value, payload: { ...value.payload, text } }, Effect.void);
    yield* service.upsert(input(11), Effect.void);
    const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isDefined(selected);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.memoryId),
      [id(10), id(11)],
    );
    assert.strictEqual(selected!.items[0]!.text, text);
    const framed = Renderer.memoryContextText(selected);
    assert.isTrue(Array.from(framed).length <= M.MEMORY_CONTEXT_MAX_CHARS);
    assert.isTrue(new TextEncoder().encode(framed).length <= M.MEMORY_CONTEXT_MAX_UTF8_BYTES);
    const store = yield* Store.MemoryStore;
    const binding = yield* store.getProjectBinding(space, { environmentId, projectId });
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId },
        projectKey: { kind: "explicit", sharedProjectId: "changed" },
        repositoryKey: null,
        version: (binding?.version ?? 0) + 1,
      },
      binding?.version ?? null,
      1,
    );
    assert.isUndefined(yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy));
  }).pipe(Effect.provide(f.live));
});
it.effect(
  "restores authoritative selected text and rejects replacement of the original selection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshot = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      const alteredText = selected!.items.map((item) => ({
        ...item,
        text: "synthetic altered data",
      }));
      Object.assign(selected!, {
        items: alteredText,
        renderedText: Renderer.renderMemoryContext(alteredText),
      });
      const restored = yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.strictEqual(restored!.items[0]!.text, input(2).payload.text);
      yield* service.upsert(input(3), Effect.void);
      const replacement = (yield* service.readContextCandidates(
        { memorySpaceId: space, limit: 100, includeQuarantined: true },
        Effect.void,
      )).items.filter((i) => i.memoryId === id(3));
      Object.assign(restored!, {
        items: replacement,
        renderedText: Renderer.renderMemoryContext(replacement),
      });
      assert.isUndefined(
        yield* snapshot.revalidate(restored!, { threadId, runId }, f.currentPolicy),
      );
    }).pipe(Effect.provide(f.live));
  },
);

// The latch pauses a real read outside the SQL lane; mutations complete before it resumes.
const policyLatch = (pauseAt = 1) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let calls = 0;
    return {
      reached,
      resume,
      policy: Effect.gen(function* () {
        if (++calls === pauseAt) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(resume);
        }
        return { grant: "read" as const, policyEpoch: 1 };
      }),
    };
  });
const interruptions = ["invalidate", "replace", "expire", "run", "ended", "unready"] as const;
const lifecycleCases = (["selection", "restore"] as const).flatMap((operation) =>
  interruptions.map((interruption) => ({ operation, interruption })),
);
it.effect.each(lifecycleCases)(
  "$operation cannot survive concurrent $interruption",
  ({ operation, interruption }) => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshots = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      const latch = yield* policyLatch(operation === "selection" ? 3 : 1);
      const pending = yield* Effect.forkChild(
        operation === "selection"
          ? snapshots.forThread(threadId, f.policy(), latch.policy)
          : snapshots.revalidate(selected!, { threadId, runId }, latch.policy),
      );
      yield* Deferred.await(latch.reached);
      let replacement: M.MemoryContextSnapshot | undefined;
      if (interruption === "invalidate") yield* snapshots.invalidate(threadId);
      if (interruption === "replace")
        replacement = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      if (interruption === "expire") yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS);
      if (interruption === "run") f.changeRun();
      if (interruption === "ended") f.end();
      if (interruption === "unready") f.unready();
      yield* Deferred.succeed(latch.resume, undefined);
      assert.isUndefined(yield* Fiber.join(pending));
      if (replacement)
        assert.isDefined(
          yield* snapshots.revalidate(replacement, { threadId, runId }, f.currentPolicy),
        );
    }).pipe(Effect.provide(f.live));
  },
);
it.effect("rejects a caller space swap with identical IDs, revisions, scopes and watermark", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    const other = M.MemorySpaceId.make(id(999));
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    // Clone the projection and immutable payload into a distinct synthetic space.
    yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json)
      SELECT ${other},payload_ref,memory_id,json_set(body_json,'$.text','synthetic foreign body'),dependencies_json FROM memory_payloads WHERE space=${space}`;
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation)
      SELECT ${other},memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,
      json_set(item_json,'$.memorySpaceId',${other},'$.revision.memorySpaceId',${other}),availability_json,generation FROM memory_items WHERE space=${space}`;
    yield* sql`INSERT INTO memory_compaction_state(space,projection_watermark)
      SELECT ${other},projection_watermark FROM memory_compaction_state WHERE space=${space}`;
    const foreign = yield* service.readContextRevisions(
      other,
      [M.MemoryId.make(id(2))],
      Effect.void,
    );
    assert.strictEqual(foreign.projectionWatermark, selected!.projectionWatermark);
    assert.strictEqual(foreign.items[0]!.revisionId, selected!.items[0]!.revisionId);
    assert.strictEqual(foreign.items[0]!.text, "synthetic foreign body");
    Object.assign(selected!, { memorySpaceId: other });
    assert.isUndefined(
      yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("rejects an exact-read page from a foreign space", () => {
  const f = fixture({ foreignRevisionSpace: M.MemorySpaceId.make(id(999)) });
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isUndefined(
      yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("restoration retains the original expiry", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    yield* service.upsert(input(2), Effect.void);
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    yield* TestClock.adjust(M.MEMORY_DERIVED_CACHE_TTL_MS - 1);
    const restored = yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy);
    assert.isDefined(restored);
    yield* TestClock.adjust(1);
    assert.isUndefined(
      yield* snapshots.revalidate(restored!, { threadId, runId }, f.currentPolicy),
    );
  }).pipe(Effect.provide(f.live));
});
it.effect("evicts oldest associations at the aggregate 32 MiB charge ceiling", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    const value = input(2);
    yield* service.upsert(
      { ...value, payload: { ...value.payload, text: "🙂".repeat(1500) + "a".repeat(3600) } },
      Effect.void,
    );
    const oldest = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.isDefined(oldest);
    const charge = 2 * new TextEncoder().encode(yield* encodeSnapshotJson(oldest!)).length;
    let current = oldest!;
    for (let n = 0; n <= Math.ceil(M.MEMORY_DERIVED_CACHE_MAX_BYTES / charge); n++) {
      const next = yield* snapshots.revalidate(current, { threadId, runId }, f.currentPolicy);
      assert.isDefined(next);
      current = next!;
    }
    assert.isUndefined(yield* snapshots.revalidate(oldest!, { threadId, runId }, f.currentPolicy));
    assert.isDefined(yield* snapshots.revalidate(current, { threadId, runId }, f.currentPolicy));
  }).pipe(Effect.provide(f.live));
});

it.effect("selects the project discovered through repository identity", () => {
  const repository: M.RepositoryIdentity = {
    canonicalKey: "example.invalid/synthetic/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://example.invalid/synthetic/repo.git",
    },
  };
  const f = fixture({ repository });
  return Effect.gen(function* () {
    const snapshots = yield* Snapshot.MemorySnapshot;
    const service = yield* Service.MemoryService;
    yield* project;
    const scope: M.MemoryScope = {
      kind: "project",
      projectKey: { kind: "repository", groupingKey: M.repositoryGroupingKeyOf(repository) },
    };
    yield* service.upsert(input(2, scope), Effect.void);
    // Initial discovery commits a new binding/watermark: discard that mixed view once.
    assert.isUndefined(yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy));
    const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
    assert.deepStrictEqual(
      selected!.items.map((i) => i.scope),
      [scope],
    );
  }).pipe(Effect.provide(f.live));
});
const survivorCases = [
  { status: "quarantined", failureCode: "scanner_pending" },
  { status: "blocked", failureCode: "forget_pending" },
  { status: "blocked", failureCode: "scanner_pending" },
] as const;
it.effect.each(survivorCases)(
  "restoration removes $status/$failureCode while retaining a visible survivor",
  ({ status, failureCode }) => {
    const f = fixture();
    return Effect.gen(function* () {
      const snapshots = yield* Snapshot.MemorySnapshot;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      yield* project;
      yield* service.upsert(input(2), Effect.void);
      yield* service.upsert(input(3), Effect.void);
      const selected = yield* snapshots.forThread(threadId, f.policy(), f.currentPolicy);
      const held = {
        memorySpaceId: space,
        memoryId: M.MemoryId.make(id(2)),
        status,
        scope: { kind: "user" as const },
        pendingSync: false,
        localAvailability: {
          exposure: "held" as const,
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
        ...(status === "blocked"
          ? { failureCode }
          : {
              conflict: {
                memorySpaceId: space,
                memoryId: M.MemoryId.make(id(2)),
                conflictId: M.MemoryConflictId.make(id(700)),
                heads: [M.MemoryRevisionId.make(id(701)), M.MemoryRevisionId.make(id(702))],
                status: "quarantined" as const,
              },
            }),
      };
      yield* sql`UPDATE memory_items SET status=${status},payload_ref=NULL,item_json=${JSON.stringify(held)} WHERE memory_id=${id(2)}`;
      const restored = yield* snapshots.revalidate(selected!, { threadId, runId }, f.currentPolicy);
      assert.deepStrictEqual(
        restored!.items.map((i) => i.memoryId),
        [id(3)],
      );
    }).pipe(Effect.provide(f.live));
  },
);

it.effect(
  "r3 cumulative admission uses one row and at most one changed write, fences derivatives on overflow and cleans on deletion",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* project;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const snapshot = yield* Snapshot.MemorySnapshot;
      yield* sql`CREATE TABLE lineage_writes (n INTEGER)`;
      yield* sql`CREATE TRIGGER lineage_insert AFTER INSERT ON memory_outbox WHEN json_extract(NEW.metadata_json,'$.kind')='threadLineage' BEGIN INSERT INTO lineage_writes VALUES (1); END`;
      yield* sql`CREATE TRIGGER lineage_update AFTER UPDATE ON memory_outbox WHEN json_extract(NEW.metadata_json,'$.kind')='threadLineage' BEGIN INSERT INTO lineage_writes VALUES (1); END`;
      yield* service.upsert(input(9500), Effect.void);
      const first = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      assert.isDefined(first);
      const restored = yield* snapshot.revalidate(first!, { threadId, runId }, f.currentPolicy);
      assert.isDefined(restored);
      assert.lengthOf(yield* sql`SELECT 1 FROM lineage_writes`, 1);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`,
        1,
      );
      const a = (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions;
      const hundred = [...a];
      for (let n = 9600; n < 9699; n++) {
        const value = input(n, {
          kind: "thread",
          thread: { environmentId, threadId: M.ThreadId.make("other") },
        });
        yield* service.upsert(value, Effect.void);
        hundred.push((yield* store.loadAggregate(space, value.memoryId)).heads[0]!);
      }
      assert.isTrue(yield* store.appendThreadLineage({ environmentId, threadId }, space, hundred));
      assert.lengthOf(yield* sql`SELECT 1 FROM lineage_writes`, 2);
      assert.lengthOf(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions,
        100,
      );
      // The 101st ID fences derivatives, while injection remains available.
      yield* service.upsert(input(9501), Effect.void);
      let sent = 0;
      const rejected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      if (rejected) sent++;
      assert.strictEqual(sent, 1);
      const overflow = yield* store.readThreadLineage({ environmentId, threadId }, space);
      assert.strictEqual(overflow.state, "overflow");
      assert.lengthOf(overflow.revisions, 100);
      assert.lengthOf(yield* sql`SELECT 1 FROM lineage_writes`, 3);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`,
        1,
      );
      const encoded = (yield* sql<{
        bytes: number;
      }>`SELECT length(CAST(metadata_json AS BLOB)) AS bytes FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`)[0]!
        .bytes;
      assert.isBelow(encoded, 4300);
      // A new context is clean; deleting the source releases its one row and identity pins.
      assert.deepStrictEqual(
        (yield* store.readThreadLineage(
          { environmentId, threadId: M.ThreadId.make("fresh") },
          space,
        )).revisions,
        [],
      );
      yield* store.deleteThreadLineage({ environmentId, threadId });
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`,
        0,
      );
    }).pipe(Effect.provide(f.live));
  },
);
it.effect("r3 a lineage writer failure cannot deliver a memory snapshot", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* project;
    const sql = yield* SqlClient.SqlClient;
    const service = yield* Service.MemoryService;
    const snapshot = yield* Snapshot.MemorySnapshot;
    yield* service.upsert(input(9700), Effect.void);
    yield* sql`CREATE TRIGGER lineage_write_failure BEFORE INSERT ON memory_outbox WHEN json_extract(NEW.metadata_json,'$.kind')='threadLineage' BEGIN SELECT RAISE(ABORT,'synthetic lineage failure'); END`;
    let sent = 0;
    const value = yield* snapshot
      .forThread(threadId, f.policy(), f.currentPolicy)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (value) sent++;
    assert.strictEqual(sent, 0);
    assert.lengthOf(
      yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`,
      0,
    );
  }).pipe(Effect.provide(f.live));
});
