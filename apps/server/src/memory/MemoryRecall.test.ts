import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { recallMatch, recallTerms } from "./store/SearchText.ts";

it.effect("normalizes recall terms and preserves code-like tokens", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(recallTerms("The 카카오톡에서 입력창을 and Foo_Bar.ts e\u0301clair"), [
      "카카오톡",
      "입력창",
      "foo_bar.ts",
      "éclair",
    ]);
    assert.strictEqual(
      recallMatch(["카카오톡", "입력창", "foo_bar.ts", "go"]),
      '"카카오톡"* OR "입력창"* OR "foo_bar.ts" OR "go"',
    );
    assert.deepStrictEqual(recallTerms("the and of to"), []);
    assert.strictEqual(recallMatch([]), undefined);
    assert.deepStrictEqual(recallTerms("카카오톡에서.ts"), ["카카오톡에서.ts"]);
    assert.deepStrictEqual(recallTerms("one two three four five six seven eight nine"), [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]);
  }),
);

import * as M from "@goat/contracts";
import * as Layer from "effect/Layer";
import * as Fixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import * as AccessFixture from "../mcp/McpToolAccess.testkit.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Settings from "../serverSettings.ts";
import * as Recall from "./MemoryRecall.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";

const encodeResult = Schema.encodeEffect(Schema.fromJsonString(M.MemoryRecallResult));

const makeLive = (
  read = Effect.succeed({
    provenance: null,
    settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
    version: 1,
  }),
  core = Fixture.core,
  shell = (id: M.ThreadId) => AccessFixture.liveThreadShell(id),
) =>
  Recall.layer.pipe(
    Layer.provideMerge(core),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.succeed({ memorySpaceId: Fixture.space, bootstrap: "ready" }),
      }),
    ),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getThreadShell: (id) => Effect.sync(() => shell(id)),
      }),
    ),
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read,
      }),
    ),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(M.EnvironmentId.make("fixture-memory-mcp")),
      }),
    ),
  );
const live = makeLive();

it.effect("recalls indexed user memories and reports no terms for stopwords", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const recall = yield* Recall.MemoryRecall;
    const input = {
      ...Fixture.upsert(),
      payload: {
        text: "카카오톡에서 입력창을 synthetic memory",
        evidence: [],
        derivedFromMemoryRevisions: [],
      },
    };
    yield* service.upsert(input, Effect.void);
    const aggregate = yield* store.loadAggregate(Fixture.space, input.memoryId);
    if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
    yield* store.index({
      memorySpaceId: Fixture.space,
      memoryId: input.memoryId,
      revisionId: aggregate.item.revision.revisionId,
      generation: aggregate.generation,
    });
    const result = yield* recall.recall({ query: "카카오톡 입력창" }, Effect.void);
    assert.strictEqual(result.items.length, 1);
    assert.deepStrictEqual(result.items[0]?.matchedTerms, ["카카오톡", "입력창"]);
    assert.strictEqual(result.items[0]?.relation, "user");
    const empty = yield* recall.recall({ query: "the and of" }, Effect.void);
    assert.deepStrictEqual(empty.items, []);
    assert.isDefined(empty.note);
  }).pipe(Effect.provide(live)),
);

const environmentId = M.EnvironmentId.make("fixture-memory-mcp");
const caller = { environmentId, threadId: M.ThreadId.make("caller") };
const setupThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.MemoryStore;
  yield* sql`CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`;
  const key = { kind: "explicit" as const, sharedProjectId: "shared" };
  for (const projectId of ["project:mcp-test", "project:other-id"]) {
    yield* store.putProjectBinding(
      {
        memorySpaceId: Fixture.space,
        project: { environmentId, projectId: M.ProjectId.make(projectId) },
        projectKey: key,
        repositoryKey: null,
        version: 1,
      },
      null,
      0,
    );
  }
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('other','project:other-id','2026-01-01',NULL),('foreign','foreign-project','2026-01-01',NULL)`;
});

const save = (
  n: number,
  scope: M.MemoryScope,
  text: string,
  derivedFromMemoryRevisions: readonly M.MemoryRevisionId[] = [],
) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const memoryId = M.MemoryId.make(Fixture.id(n));
    yield* service.upsert(
      {
        ...Fixture.upsert(n + 100),
        memoryId,
        scope,
        payload: {
          text,
          evidence: [],
          derivedFromMemoryRevisions: [...derivedFromMemoryRevisions],
        },
      },
      Effect.void,
    );
    const aggregate = yield* store.loadAggregate(Fixture.space, memoryId);
    if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
    const revisionId = aggregate.item.revision.revisionId;
    yield* store.index({
      memorySpaceId: Fixture.space,
      memoryId,
      revisionId,
      generation: aggregate.generation,
    });
    return revisionId;
  });

it.effect("keeps all bounded candidates with a stable memory id tie-break", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    for (let n = 1; n <= 51; n++) yield* save(n, { kind: "user" }, "identical needle");
    const first = yield* store.recallCandidates(Fixture.space, ["user"], '"needle"*');
    const second = yield* store.recallCandidates(Fixture.space, ["user"], '"needle"*');
    const expected = Array.from({ length: 51 }, (_, index) =>
      M.MemoryId.make(Fixture.id(index + 1)),
    );
    assert.deepStrictEqual(
      first.candidates.map((item) => item.memoryId),
      expected,
    );
    assert.deepStrictEqual(
      second.candidates.map((item) => item.memoryId),
      expected,
    );
  }).pipe(Effect.provide(live)),
);

it.effect(
  "recalls only the caller project and appends returned revisions and dependency closure",
  () =>
    Effect.gen(function* () {
      yield* setupThreads;
      const own = yield* save(10, { kind: "thread", thread: caller }, "release decision parent");
      const related = yield* save(
        11,
        { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("other") } },
        "release decision related",
        [own],
      );
      yield* save(
        12,
        { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("foreign") } },
        "release decision foreign",
      );
      yield* save(
        13,
        { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "shared" } },
        "release decision project",
      );
      yield* save(14, { kind: "user" }, "release decision user");
      const recall = yield* Recall.MemoryRecall;
      const result = yield* recall.recall({ query: "release decision" }, Effect.void, caller);
      assert.deepStrictEqual(
        new Set(result.items.map((hit) => hit.relation)),
        new Set(["this_thread", "project_thread", "project", "user"]),
      );
      assert.isFalse(result.items.some((hit) => hit.memoryId === M.MemoryId.make(Fixture.id(12))));
      const store = yield* Store.MemoryStore;
      const lineage = yield* store.readThreadLineage(caller, Fixture.space);
      assert.includeMembers([...lineage.revisions], [own, related]);
      const userOnly = yield* recall.recall({ query: "release decision" }, Effect.void);
      assert.deepStrictEqual(
        userOnly.items.map((hit) => hit.relation),
        ["user"],
      );
    }).pipe(Effect.provide(live)),
);

it.effect("finds a topic after conversational question words", () =>
  Effect.gen(function* () {
    yield* save(100, { kind: "user" }, "deployment uses the nightly channel");
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall(
      { query: "Can you tell me what we decided about deployment?" },
      Effect.void,
    );
    assert.deepStrictEqual(result.terms, ["deployment"]);
    assert.strictEqual(result.items[0]?.memoryId, M.MemoryId.make(Fixture.id(100)));
    assert.deepStrictEqual(result.items[0]?.matchedTerms, ["deployment"]);
    assert.deepStrictEqual(recallTerms("What did we decide about 배포에서 foo_bar.ts?"), [
      "배포",
      "foo_bar.ts",
    ]);
  }).pipe(Effect.provide(live)),
);

it.effect("ranks the current thread above 50 equal-text user memories", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    for (let n = 1; n <= 50; n++) yield* save(n, { kind: "user" }, "identical needle");
    yield* save(51, { kind: "thread", thread: caller }, "identical needle");
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "needle" }, Effect.void, caller);
    assert.strictEqual(result.items[0]?.memoryId, M.MemoryId.make(Fixture.id(51)));
    assert.strictEqual(result.items[0]?.relation, "this_thread");
  }).pipe(Effect.provide(live)),
);

it.effect(
  "discovers and commits repository binding before selecting project and related scopes",
  () => {
    const identity: M.RepositoryIdentity = {
      canonicalKey: "github.com/example/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
      },
    };
    const core = Fixture.coreWithResolver(() => Effect.succeed(identity));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('project:mcp-test','/synthetic',NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('other','project:other-id','2026-01-01',NULL)`;
      const key = { kind: "repository" as const, groupingKey: M.repositoryGroupingKeyOf(identity) };
      yield* store.putProjectBinding(
        {
          memorySpaceId: Fixture.space,
          project: { environmentId, projectId: M.ProjectId.make("project:other-id") },
          projectKey: key,
          repositoryKey: key,
          version: 1,
        },
        null,
        0,
      );
      yield* save(101, { kind: "project", projectKey: key }, "deployment project");
      yield* save(
        102,
        { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("other") } },
        "deployment related",
      );
      const recall = yield* Recall.MemoryRecall;
      const result = yield* recall.recall({ query: "deployment" }, Effect.void, caller);
      assert.deepStrictEqual(
        new Set(result.items.map((hit) => hit.relation)),
        new Set(["project", "project_thread"]),
      );
      assert.strictEqual(result.indexCoverage.status, "complete");
      assert.isFalse(result.indexCoverage.projectScopeUnavailable);
      assert.deepStrictEqual(
        (yield* store.getProjectBinding(Fixture.space, {
          environmentId,
          projectId: M.ProjectId.make("project:mcp-test"),
        }))?.projectKey,
        key,
      );
    }).pipe(Effect.provide(makeLive(undefined, core)));
  },
);

it.effect(
  "reports partial project coverage when identity is unavailable, but user-only recall is complete",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('project:mcp-test','/synthetic',NULL)`;
      yield* sql`CREATE TABLE orchestration_events (application_event_version INTEGER, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
      yield* save(103, { kind: "user" }, "deployment user");
      const recall = yield* Recall.MemoryRecall;
      const withCaller = yield* recall.recall({ query: "deployment" }, Effect.void, caller);
      assert.strictEqual(withCaller.indexCoverage.status, "partial");
      assert.isTrue(withCaller.indexCoverage.projectScopeUnavailable);
      const userOnly = yield* recall.recall({ query: "deployment" }, Effect.void);
      assert.strictEqual(userOnly.indexCoverage.status, "complete");
      assert.isFalse(userOnly.indexCoverage.projectScopeUnavailable);
    }).pipe(Effect.provide(live)),
);

it.effect.each(["project", "epoch", "permit"] as const)(
  "fences %s changes during repository discovery before committing a binding",
  (change) => {
    let projectId = M.ProjectId.make("project:mcp-test");
    let version = 1;
    let allowed = true;
    const read = Effect.sync(() => ({
      provenance: null,
      settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
      version,
    }));
    const core = Fixture.coreWithResolver(() =>
      Effect.sync(() => {
        if (change === "project") projectId = M.ProjectId.make("project:other-id");
        if (change === "epoch") version = 2;
        if (change === "permit") allowed = false;
        return {
          canonicalKey: "github.com/example/repo",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://github.com/example/repo.git",
          },
        };
      }),
    );
    const shell = (id: M.ThreadId) => ({ ...AccessFixture.liveThreadShell(id), projectId });
    const permit = Effect.suspend(() =>
      allowed ? Effect.void : Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('project:mcp-test','/synthetic',NULL)`;
      const recall = yield* Recall.MemoryRecall;
      const result = yield* recall
        .recall({ query: "deployment" }, permit, caller)
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryAccessError");
      const store = yield* Store.MemoryStore;
      assert.isUndefined(
        yield* store.getProjectBinding(Fixture.space, {
          environmentId,
          projectId: M.ProjectId.make("project:mcp-test"),
        }),
      );
    }).pipe(Effect.provide(makeLive(read, core, shell)));
  },
);

it.effect("denies discovery before accessing the repository resolver", () => {
  let resolutions = 0;
  const core = Fixture.coreWithResolver(() =>
    Effect.sync(() => {
      resolutions++;
      return null;
    }),
  );
  return Effect.gen(function* () {
    const recall = yield* Recall.MemoryRecall;
    const denied = Effect.fail(new Service.MemoryAccessError({ code: "unavailable" }));
    assert.strictEqual(
      (yield* recall.recall({ query: "deployment" }, denied, caller).pipe(Effect.flip))._tag,
      "MemoryAccessError",
    );
    assert.strictEqual(resolutions, 0);
  }).pipe(Effect.provide(makeLive(undefined, core)));
});

it.effect("a permit revoked before consume rolls back lineage", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    yield* save(20, { kind: "user" }, "rollback release");
    let calls = 0;
    const permit = Effect.suspend(() =>
      ++calls === 5
        ? Effect.fail(new Service.MemoryAccessError({ code: "unavailable" }))
        : Effect.void,
    );
    const recall = yield* Recall.MemoryRecall;
    assert.strictEqual(
      (yield* recall.recall({ query: "rollback release" }, permit, caller).pipe(Effect.flip))._tag,
      "MemoryAccessError",
    );
    const store = yield* Store.MemoryStore;
    assert.deepStrictEqual((yield* store.readThreadLineage(caller, Fixture.space)).revisions, []);
  }).pipe(Effect.provide(live)),
);

it.effect("a settings version change between readiness reads fences recall", () => {
  let reads = 0;
  const read = Effect.sync(() => ({
    provenance: null,
    settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
    version: ++reads,
  }));
  return Effect.gen(function* () {
    const recall = yield* Recall.MemoryRecall;
    const error = yield* recall.recall({ query: "release" }, Effect.void).pipe(Effect.flip);
    assert.strictEqual(error._tag, "MemoryStoreConflict");
  }).pipe(Effect.provide(makeLive(read)));
});

it.effect("a settings change at commit fences the transaction and rolls back lineage", () => {
  let version = 1;
  let calls = 0;
  const read = Effect.sync(() => ({
    provenance: null,
    settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
    version,
  }));
  return Effect.gen(function* () {
    yield* setupThreads;
    yield* save(30, { kind: "user" }, "fenced release");
    const permit = Effect.sync(() => {
      if (++calls === 6) version = 2;
    });
    const recall = yield* Recall.MemoryRecall;
    const error = yield* recall
      .recall({ query: "fenced release" }, permit, caller)
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "MemoryStoreConflict");
    if (error._tag === "MemoryStoreConflict") assert.strictEqual(error.code, "fenced");
    const store = yield* Store.MemoryStore;
    assert.deepStrictEqual((yield* store.readThreadLineage(caller, Fixture.space)).revisions, []);
  }).pipe(Effect.provide(makeLive(read)));
});

it.effect("related-thread coverage truncates only at the 2001st thread", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM orchestration_v2_projection_threads`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO orchestration_v2_projection_threads SELECT printf('thread-%04d',i),'project:other-id',printf('%04d',i),NULL FROM n`;
    const recall = yield* Recall.MemoryRecall;
    const first = yield* recall.recall({ query: "release" }, Effect.void, caller);
    assert.isFalse(first.indexCoverage.relatedThreadsTruncated);
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('thread-extra','project:other-id','9999',NULL)`;
    const second = yield* recall.recall({ query: "release" }, Effect.void, caller);
    assert.isTrue(second.indexCoverage.relatedThreadsTruncated);
    assert.strictEqual(second.indexCoverage.status, "partial");
  }).pipe(Effect.provide(live)),
);

it.effect("ranks complete matches first and flags single-term weak results", () =>
  Effect.gen(function* () {
    yield* save(40, { kind: "user" }, "alpha bravo charlie delta");
    yield* save(41, { kind: "user" }, "alpha irrelevant document");
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "alpha bravo charlie delta" }, Effect.void);
    assert.strictEqual(result.items[0]?.memoryId, M.MemoryId.make(Fixture.id(40)));
    assert.strictEqual(
      result.items.find((hit) => hit.memoryId === M.MemoryId.make(Fixture.id(41)))?.match,
      "weak",
    );
    assert.isTrue(
      result.items.every((hit) => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1),
    );
  }).pipe(Effect.provide(live)),
);

it.effect("packs returned hits within the response byte limit before recording lineage", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    for (let n = 50; n < 56; n++) yield* save(n, { kind: "user" }, `packing ${"x".repeat(16000)}`);
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "packing", limit: 20 }, Effect.void, caller);
    const json = yield* encodeResult(result);
    assert.isAtMost(new TextEncoder().encode(json).length, M.MEMORY_PAGE_MAX_UTF8_BYTES);
    assert.isAbove(result.items.length, 0);
    assert.isBelow(result.items.length, 6);
    assert.strictEqual(result.note, "Some matches did not fit in the response.");
    const store = yield* Store.MemoryStore;
    const lineage = yield* store.readThreadLineage(caller, Fixture.space);
    assert.deepStrictEqual(
      new Set(lineage.revisions),
      new Set(result.items.map((item) => item.revisionId)),
    );
  }).pipe(Effect.provide(live)),
);

it.effect("excludes pending forget and a thread after its project binding changes", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    yield* save(
      70,
      { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("other") } },
      "binding reminder",
    );
    yield* save(71, { kind: "user" }, "binding reminder pending");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_pending_forget_intents(space,memory_id,operation_id,requested_at_utc,attempts,submission_state) VALUES (${Fixture.space},${M.MemoryId.make(Fixture.id(71))},${M.MemoryOperationId.make(Fixture.id(900))},'2026-01-01T00:00:00.000Z',0,'unsubmitted')`;
    const recall = yield* Recall.MemoryRecall;
    const first = yield* recall.recall({ query: "binding reminder" }, Effect.void, caller);
    assert.deepStrictEqual(
      first.items.map((item) => item.memoryId),
      [M.MemoryId.make(Fixture.id(70))],
    );
    const store = yield* Store.MemoryStore;
    yield* store.putProjectBinding(
      {
        memorySpaceId: Fixture.space,
        project: { environmentId, projectId: M.ProjectId.make("project:other-id") },
        projectKey: { kind: "explicit", sharedProjectId: "different" },
        repositoryKey: null,
        version: 2,
      },
      1,
      0,
    );
    const next = yield* recall.recall({ query: "binding reminder" }, Effect.void, caller);
    assert.deepStrictEqual(next.items, []);
  }).pipe(Effect.provide(live)),
);

it.effect(
  "does not return held, quarantined, forgotten or foreign-space bodies or record their lineage",
  () =>
    Effect.gen(function* () {
      yield* setupThreads;
      const store = yield* Store.MemoryStore;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      const visible = yield* save(110, { kind: "user" }, "private marker visible");
      const heldRevision = yield* save(111, { kind: "user" }, "private marker held");
      const quarantinedRevision = yield* save(112, { kind: "user" }, "private marker quarantined");
      const forgottenRevision = yield* save(113, { kind: "user" }, "private marker forgotten");
      const heldId = M.MemoryId.make(Fixture.id(111));
      const quarantineId = M.MemoryId.make(Fixture.id(112));
      const heldAggregate = yield* store.loadAggregate(Fixture.space, heldId);
      if (heldAggregate.item?.status !== "active") throw new Error("held fixture is not active");
      const availability: M.MemoryLocalAvailability = {
        exposure: "held",
        reasons: ["scanner_pending"],
        deferred: [],
        cleanupPending: false,
      };
      const held = {
        memorySpaceId: Fixture.space,
        memoryId: heldId,
        status: "blocked",
        scope: heldAggregate.item.scope,
        pendingSync: false,
        failureCode: "scanner_pending",
        localAvailability: availability,
      };
      yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(held)},availability_json=${JSON.stringify(availability)} WHERE space=${Fixture.space} AND memory_id=${heldId}`;
      const quarantined: M.MemoryItem = {
        memorySpaceId: Fixture.space,
        memoryId: quarantineId,
        status: "quarantined",
        scope: { kind: "user" },
        pendingSync: false,
        localAvailability: { ...availability, reasons: ["conflicted"] },
        conflict: {
          memorySpaceId: Fixture.space,
          memoryId: quarantineId,
          conflictId: M.MemoryConflictId.make(Fixture.id(500)),
          heads: [quarantinedRevision, M.MemoryRevisionId.make(Fixture.id(503))].sort(),
          status: "quarantined",
        },
      };
      yield* sql`UPDATE memory_items SET status='quarantined',item_json=${JSON.stringify(quarantined)},availability_json=${JSON.stringify(quarantined.localAvailability)} WHERE space=${Fixture.space} AND memory_id=${quarantineId}`;
      const indexed = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_items WHERE space=${Fixture.space} AND memory_id IN (${heldId},${quarantineId}) AND index_state='ready' AND indexed_generation=generation`;
      assert.strictEqual(indexed[0]?.count, 2);
      yield* service.forget(
        {
          memorySpaceId: Fixture.space,
          memoryId: M.MemoryId.make(Fixture.id(113)),
          operationId: M.MemoryOperationId.make(Fixture.id(501)),
          expectedHeads: [],
        },
        Effect.void,
      );
      const foreignSpace = M.MemorySpaceId.make(Fixture.id(999));
      const foreignEnvironment = M.EnvironmentId.make("foreign-environment");
      const foreignService = yield* Service.MemoryService.pipe(
        Effect.provide(
          Layer.fresh(Service.layer).pipe(
            Layer.provide(
              Layer.succeed(Environment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(foreignEnvironment),
              }),
            ),
            Layer.provide(
              Layer.succeed(Settings.MemoryHubCommittedSettings, {
                read: Effect.succeed({
                  provenance: null,
                  settings: { mode: "hub" as const, memorySpaceId: foreignSpace },
                  version: 1,
                }),
              }),
            ),
            Layer.provide(
              Layer.mock(Repository.RepositoryIdentityResolver)({
                resolve: () => Effect.succeed(null),
              }),
            ),
          ),
        ),
      );
      const foreignId = M.MemoryId.make(Fixture.id(114));
      yield* foreignService.upsert(
        {
          ...Fixture.upsert(502),
          memorySpaceId: foreignSpace,
          memoryId: foreignId,
          payload: {
            text: "private marker foreign space",
            evidence: [],
            derivedFromMemoryRevisions: [],
          },
        },
        Effect.void,
      );
      const foreign = yield* store.loadAggregate(foreignSpace, foreignId);
      if (foreign.item?.status !== "active") throw new Error("foreign fixture is not active");
      const foreignRevision = foreign.item.revision.revisionId;
      yield* store.index({
        memorySpaceId: foreignSpace,
        memoryId: foreignId,
        revisionId: foreignRevision,
        generation: foreign.generation,
      });
      const recall = yield* Recall.MemoryRecall;
      const result = yield* recall.recall({ query: "private marker" }, Effect.void, caller);
      assert.deepStrictEqual(
        result.items.map((hit) => hit.revisionId),
        [visible],
      );
      assert.notInclude(result.items.map((hit) => hit.text).join(" "), "held");
      assert.isAtLeast(result.indexCoverage.eligibleItems, result.items.length);
      const lineage = yield* store.readThreadLineage(caller, Fixture.space);
      assert.deepStrictEqual(lineage.revisions, [visible]);
      for (const revision of [
        heldRevision,
        quarantinedRevision,
        forgottenRevision,
        foreignRevision,
      ])
        assert.notInclude(lineage.revisions, revision);
    }).pipe(Effect.provide(live)),
);

it.effect("an unfinished index backfill returns unavailable coverage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) SELECT ${Fixture.space},printf('00000000-0000-4000-8000-%012d',i),'{}','user','[]','quarantined',0,'{}','{}' FROM n`;
    yield* sql`UPDATE memory_search_backfill SET after_rowid=0,ready=0 WHERE singleton=1`;
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "release" }, Effect.void);
    assert.strictEqual(result.indexCoverage.status, "unavailable");
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.note, "Memory search index is still building; try again shortly.");
  }).pipe(Effect.provide(live)),
);

it.effect("keeps Korean subjects after conversational words and after eight distinct terms", () =>
  Effect.gen(function* () {
    yield* save(800, { kind: "user" }, "배포 결정");
    const recall = yield* Recall.MemoryRecall;
    for (const query of [
      "지난번에 우리가 함께 이야기했던 내용을 다시 한번 자세하게 찾아보고 배포 결정 알려줘",
      "alpha bravo charlie delta echo foxtrot golf hotel 배포",
    ]) {
      const result = yield* recall.recall({ query }, Effect.void);
      assert.include(result.terms, "배포");
      assert.deepStrictEqual(
        result.items.map((i) => i.memoryId),
        [M.MemoryId.make(Fixture.id(800))],
      );
    }
  }).pipe(Effect.provide(live)),
);

it.effect("reports unknown source project bindings as partial scope coverage", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    yield* save(
      801,
      { kind: "thread", thread: { environmentId, threadId: M.ThreadId.make("foreign") } },
      "deployment",
    );
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "deployment" }, Effect.void, caller);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.indexCoverage.status, "partial");
    assert.isTrue(result.indexCoverage.projectScopeUnavailable);
  }).pipe(Effect.provide(live)),
);

it.effect.each(["grant", "hub"] as const)(
  "rolls back repository discovery if %s changes after its binding write",
  (change) => {
    let allowed = true;
    let version = 1;
    const original = Fixture.coreWithResolver(() =>
      Effect.succeed({
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repo.git",
        },
      }),
    );
    const core = Layer.effect(
      Service.MemoryService,
      Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        return Service.MemoryService.of({
          ...service,
          getProjectBinding: (...args) =>
            service.getProjectBinding(...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (change === "grant") allowed = false;
                  else version++;
                }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provideMerge(original));
    const read = Effect.sync(() => ({
      provenance: null,
      settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
      version,
    }));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('project:mcp-test','/synthetic',NULL)`;
      const recall = yield* Recall.MemoryRecall;
      const permit = Effect.suspend(() =>
        allowed ? Effect.void : Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
      );
      yield* recall.recall({ query: "deployment" }, permit, caller).pipe(Effect.flip);
      const store = yield* Store.MemoryStore;
      assert.isUndefined(
        yield* store.getProjectBinding(Fixture.space, {
          environmentId,
          projectId: M.ProjectId.make("project:mcp-test"),
        }),
      );
    }).pipe(Effect.provide(makeLive(read, core)));
  },
);

it.effect("never returns a forgotten memory", () =>
  Effect.gen(function* () {
    yield* setupThreads;
    yield* save(80, { kind: "user" }, "forgotten secret plan");
    const service = yield* Service.MemoryService;
    yield* service.forget(
      {
        memorySpaceId: Fixture.space,
        memoryId: M.MemoryId.make(Fixture.id(80)),
        operationId: M.MemoryOperationId.make(Fixture.id(901)),
        expectedHeads: [],
      },
      Effect.void,
    );
    const recall = yield* Recall.MemoryRecall;
    const result = yield* recall.recall({ query: "forgotten secret plan" }, Effect.void, caller);
    assert.deepStrictEqual(result.items, []);
  }).pipe(Effect.provide(live)),
);
