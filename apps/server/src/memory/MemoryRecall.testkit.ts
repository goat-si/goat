import * as Effect from "effect/Effect";
import * as M from "@goat/contracts";
import * as Layer from "effect/Layer";
import * as Fixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import * as AccessFixture from "../mcp/McpToolAccess.testkit.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Recall from "./MemoryRecall.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";

export const makeLive = (
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
export const live = makeLive();

export const environmentId = M.EnvironmentId.make("fixture-memory-mcp");
export const caller = { environmentId, threadId: M.ThreadId.make("caller") };
export const setupThreads = Effect.gen(function* () {
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

export const save = (
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
