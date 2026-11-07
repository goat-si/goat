import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Snapshot from "./MemorySnapshot.ts";
import {
  id,
  space,
  environmentId,
  threadId,
  runId,
  projectId,
  input,
  fixture,
  project,
} from "./MemorySnapshot.testkit.ts";

it.effect("fences a hub version change across readiness", () => {
  let change = () => {};
  const f = fixture({ onReadiness: () => change() });
  change = () => f.setHubVersion(2);
  return Effect.gen(function* () {
    yield* project;
    const snapshot = yield* Snapshot.MemorySnapshot;
    const store = yield* Store.MemoryStore;
    assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
    assert.deepStrictEqual(
      (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions,
      [],
    );
  }).pipe(Effect.provide(f.live));
});

it.effect.each([{ withMemory: false }, { withMemory: true }])(
  "fences hub ABA at commit even for an empty briefing (withMemory=$withMemory)",
  ({ withMemory }) => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* project;
      const service = yield* Service.MemoryService;
      const snapshot = yield* Snapshot.MemorySnapshot;
      const store = yield* Store.MemoryStore;
      if (withMemory) yield* service.upsert(input(2), Effect.void);
      f.setPolicy({
        grant: "read",
        policyEpoch: 1,
        finalAuthority: Effect.sync(() => {
          f.setHubVersion(2);
          return true;
        }),
      });
      assert.isUndefined(yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy));
      assert.deepStrictEqual(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions,
        [],
      );
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage'`,
        0,
      );
    }).pipe(Effect.provide(f.live));
  },
);
it.effect("injects strong related-thread matches after the current thread", () => {
  const f = fixture({ message: "카카오톡 입력창" });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const service = yield* Service.MemoryService;
    const snapshot = yield* Snapshot.MemorySnapshot;
    yield* project;
    const key = { kind: "explicit" as const, sharedProjectId: "shared" };
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId },
        projectKey: key,
        repositoryKey: null,
        version: 1,
      },
      null,
      0,
    );
    const other = M.ThreadId.make("related");
    const otherProject = M.ProjectId.make("related-project");
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId: otherProject },
        projectKey: key,
        repositoryKey: null,
        version: 1,
      },
      null,
      0,
    );
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${other},${otherProject},'related','codex','default','default','2026-01-01','2026-01-01','{}')`;
    yield* service.upsert(
      input(2, { kind: "thread", thread: { environmentId, threadId } }),
      Effect.void,
    );
    for (const n of [3, 4, 5, 6]) {
      const related = {
        ...input(n, { kind: "thread", thread: { environmentId, threadId: other } }),
        payload: { text: "카카오톡 입력창", evidence: [], derivedFromMemoryRevisions: [] },
      };
      yield* service.upsert(related, Effect.void);
      const aggregate = yield* store.loadAggregate(space, related.memoryId);
      if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
      yield* store.index({
        memorySpaceId: space,
        memoryId: related.memoryId,
        revisionId: aggregate.item.revision.revisionId,
        generation: aggregate.generation,
      });
    }
    const foreignProject = M.ProjectId.make("foreign-project");
    const foreignThread = M.ThreadId.make("foreign-thread");
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId: foreignProject },
        projectKey: { kind: "explicit", sharedProjectId: "foreign" },
        repositoryKey: null,
        version: 1,
      },
      null,
      0,
    );
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${foreignThread},${foreignProject},'foreign','codex','default','default','2026-01-01','2026-01-01','{}')`;
    const otherEnvironment = M.EnvironmentId.make("other-environment");
    const foreignService = yield* Service.MemoryService.pipe(
      Effect.provide(
        Layer.fresh(Service.layer).pipe(
          Layer.provide(
            Layer.succeed(Environment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(otherEnvironment),
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
    for (const [n, thread] of [
      [7, { environmentId, threadId: foreignThread }],
      [8, { environmentId: otherEnvironment, threadId: other }],
    ] as const) {
      const foreign = {
        ...input(n, { kind: "thread", thread }),
        payload: { text: "카카오톡 입력창", evidence: [], derivedFromMemoryRevisions: [] },
      };
      yield* (n === 8 ? foreignService : service).upsert(foreign, Effect.void);
      const aggregate = yield* store.loadAggregate(space, foreign.memoryId);
      if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
      yield* store.index({
        memorySpaceId: space,
        memoryId: foreign.memoryId,
        revisionId: aggregate.item.revision.revisionId,
        generation: aggregate.generation,
      });
    }
    const withoutAuthority = { grant: "read" as const, policyEpoch: 1 };
    const baseOnly = yield* snapshot.forThread(
      threadId,
      withoutAuthority,
      Effect.succeed(withoutAuthority),
    );
    assert.isUndefined(baseOnly);
    for (const [text, role] of [
      ["unrelated search", "user"],
      ["카카오톡 apple banana cherry", "user"],
      ["카카오톡 입력창", "assistant"],
      ["", "user"],
    ] as const) {
      f.setMessage(text, role);
      const result = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      assert.deepStrictEqual(
        result?.items.map((item) => item.memoryId),
        [id(2)],
      );
    }
    f.setMessage("카카오톡 입력창");
    const first = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
    assert.strictEqual(selected?.renderedText, first?.renderedText);
    assert.deepStrictEqual(
      selected?.items.map((item) => item.memoryId),
      [id(2), id(3), id(4), id(5)],
    );
    yield* store.putProjectBinding(
      {
        memorySpaceId: space,
        project: { environmentId, projectId: otherProject },
        projectKey: { kind: "explicit", sharedProjectId: "different" },
        repositoryKey: null,
        version: 2,
      },
      1,
      0,
    );
    const restored = yield* snapshot.revalidate(selected!, { threadId, runId }, f.currentPolicy);
    assert.deepStrictEqual(
      restored?.items.map((item) => item.memoryId),
      [id(2)],
    );
  }).pipe(Effect.provide(f.live));
});
it.effect.each(["none", "plain", "dependencies", "related-dependencies"] as const)(
  "limits related injection to the full lineage union with $0 base",
  (base) => {
    const f = fixture({ message: "카카오톡 입력창" });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const service = yield* Service.MemoryService;
      const snapshot = yield* Snapshot.MemorySnapshot;
      yield* project;
      const projectKey = { kind: "explicit" as const, sharedProjectId: "shared" };
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
      const other = M.ThreadId.make("related");
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${other},${projectId},'related','codex','default','default','2026-01-01','2026-01-01','{}')`;
      const dependencies: M.MemoryRevisionId[] = [];
      if (base === "dependencies" || base === "related-dependencies") {
        for (const n of [5, 6]) {
          const dependency = input(n, {
            kind: "thread",
            thread: { environmentId, threadId: M.ThreadId.make("unrelated") },
          });
          yield* service.upsert(dependency, Effect.void);
          const aggregate = yield* store.loadAggregate(space, dependency.memoryId);
          if (aggregate.item?.status !== "active")
            throw new Error("fixture dependency is not active");
          dependencies.push(aggregate.item.revision.revisionId);
        }
      }
      for (const n of [3, 4]) {
        const value = {
          ...input(n, { kind: "thread", thread: { environmentId, threadId: other } }),
          payload: {
            text: "카카오톡 입력창",
            evidence: [],
            derivedFromMemoryRevisions:
              base === "related-dependencies" && n === 3 ? dependencies : [],
          },
        };
        yield* service.upsert(value, Effect.void);
        const aggregate = yield* store.loadAggregate(space, value.memoryId);
        if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
        yield* store.index({
          memorySpaceId: space,
          memoryId: value.memoryId,
          revisionId: aggregate.item.revision.revisionId,
          generation: aggregate.generation,
        });
      }
      if (base === "plain" || base === "dependencies") {
        const own = input(2, { kind: "thread", thread: { environmentId, threadId } });
        yield* service.upsert(
          { ...own, payload: { ...own.payload, derivedFromMemoryRevisions: dependencies } },
          Effect.void,
        );
      }
      yield* store.appendThreadLineage(
        { environmentId, threadId },
        space,
        Array.from({ length: base === "dependencies" ? 77 : 79 }, (_, n) =>
          M.MemoryRevisionId.make(id(2000 + n)),
        ),
      );
      const selected = yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy);
      assert.deepStrictEqual(
        selected?.items.map((item) => item.memoryId),
        base === "none" ? [id(3)] : base === "related-dependencies" ? [id(4)] : [id(2)],
      );
      assert.strictEqual(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions.length,
        80,
      );
    }).pipe(Effect.provide(f.live));
  },
);
it.effect.each([
  "rebind",
  "rebind-version",
  "rebind-after-filter",
  "destination-binding",
  "destination-project",
  "destination-run",
  "token-replaced",
  "revoke",
  "hold",
  "growth",
] as const)("rejects the entire snapshot if $0 changes before admission", (change) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let admissions = 0;
      const f = fixture({
        message: "카카오톡 입력창",
        beforeAdmission: Effect.suspend(() => {
          admissions++;
          return change === "rebind-after-filter" && admissions === 1
            ? Effect.void
            : Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed)));
        }),
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const service = yield* Service.MemoryService;
        const snapshot = yield* Snapshot.MemorySnapshot;
        yield* project;
        const sourceProject = M.ProjectId.make("source-project");
        const key = { kind: "explicit" as const, sharedProjectId: "shared" };
        for (const target of [projectId, sourceProject]) {
          yield* store.putProjectBinding(
            {
              memorySpaceId: space,
              project: { environmentId, projectId: target },
              projectKey: key,
              repositoryKey: null,
              version: 1,
            },
            null,
            0,
          );
        }
        const source = M.ThreadId.make("source");
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${source},${sourceProject},'source','codex','default','default','2026-01-01','2026-01-01','{}')`;
        yield* service.upsert(
          input(2, { kind: "thread", thread: { environmentId, threadId } }),
          Effect.void,
        );
        const related = {
          ...input(3, { kind: "thread", thread: { environmentId, threadId: source } }),
          payload: { text: "카카오톡 입력창", evidence: [], derivedFromMemoryRevisions: [] },
        };
        yield* service.upsert(related, Effect.void);
        const aggregate = yield* store.loadAggregate(space, related.memoryId);
        if (aggregate.item?.status !== "active") throw new Error("fixture item is not active");
        yield* store.index({
          memorySpaceId: space,
          memoryId: related.memoryId,
          revisionId: aggregate.item.revision.revisionId,
          generation: aggregate.generation,
        });
        const original =
          change === "rebind-after-filter"
            ? yield* snapshot.forThread(threadId, f.policy(), f.currentPolicy)
            : undefined;
        if (change === "rebind-after-filter") assert.isDefined(original);
        const fiber = yield* (
          original
            ? snapshot.revalidate(original, { threadId, runId }, f.currentPolicy)
            : snapshot.forThread(threadId, f.policy(), f.currentPolicy)
        ).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        if (
          change === "rebind" ||
          change === "rebind-version" ||
          change === "rebind-after-filter"
        ) {
          yield* store.putProjectBinding(
            {
              memorySpaceId: space,
              project: { environmentId, projectId: sourceProject },
              projectKey:
                change === "rebind-version" ? key : { kind: "explicit", sharedProjectId: "other" },
              repositoryKey: null,
              version: 2,
            },
            1,
            0,
          );
        } else if (change === "destination-binding") {
          yield* store.putProjectBinding(
            {
              memorySpaceId: space,
              project: { environmentId, projectId },
              projectKey: key,
              repositoryKey: null,
              version: 2,
            },
            1,
            0,
          );
        } else if (change === "destination-project") {
          yield* sql`UPDATE orchestration_v2_projection_threads SET project_id=${sourceProject} WHERE thread_id=${threadId}`;
        } else if (change === "destination-run") {
          yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id=${runId}`;
        } else if (change === "revoke") {
          f.setPolicy({ grant: "none", policyEpoch: 2 });
        } else if (change === "token-replaced") {
          yield* snapshot.invalidate(threadId);
        } else if (change === "hold") {
          const held = {
            memorySpaceId: space,
            memoryId: related.memoryId,
            status: "blocked",
            scope: related.scope,
            pendingSync: false,
            localAvailability: {
              exposure: "held",
              reasons: [],
              deferred: [],
              cleanupPending: false,
            },
            failureCode: "scanner_pending",
          };
          yield* sql`UPDATE memory_items SET status='blocked',payload_ref=NULL,item_json=${JSON.stringify(held)} WHERE memory_id=${related.memoryId}`;
          assert.deepStrictEqual(
            (yield* store.loadAggregate(space, related.memoryId)).heads,
            aggregate.heads,
          );
        } else {
          yield* store.appendThreadLineage(
            { environmentId, threadId },
            space,
            Array.from({ length: 80 }, (_, n) => M.MemoryRevisionId.make(id(3000 + n))),
          );
        }
        yield* Deferred.succeed(proceed, undefined);
        assert.isUndefined(yield* Fiber.join(fiber));
        const lineage = yield* store.readThreadLineage({ environmentId, threadId }, space);
        assert.strictEqual(lineage.revisions.length, change === "growth" ? 80 : original ? 2 : 0);
        if (original)
          assert.isUndefined(
            yield* snapshot.revalidate(original, { threadId, runId }, f.currentPolicy),
          );
      }).pipe(Effect.provide(f.live));
    }),
  ),
);
