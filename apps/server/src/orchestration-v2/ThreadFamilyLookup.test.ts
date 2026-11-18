import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeOmittableShellReaders } from "./ThreadFamilyLookup.ts";

const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

it.layer(layer)("thread family title lookup", (it) => {
  it.effect(
    "returns existing active and archived titles but omits deleted and unknown threads",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const root = ThreadId.make("thread:root");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const create = Effect.fn("test.createThread")(function* (name: string, archived: boolean) {
          const threadId = ThreadId.make(`thread:${name}`);
          const thread = {
            createdBy: "user" as const,
            creationSource: "web" as const,
            id: threadId,
            projectId: ProjectId.make("project:family"),
            title: `Title ${name}`,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: threadId === root ? null : root,
              relationshipToParent: threadId === root ? null : ("fork" as const),
              rootThreadId: root,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: archived ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* store.apply({
            id: EventId.make(`event:${name}:create`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          });
          return thread;
        });
        yield* create("root", false);
        const active = yield* create("active", false);
        const archived = yield* create("archived", true);
        const deleted = yield* create("deleted", false);
        yield* store.apply({
          id: EventId.make("event:deleted:delete"),
          type: "thread.deleted",
          threadId: deleted.id,
          occurredAt: now,
          payload: { ...deleted, deletedAt: now },
        });
        const readers = makeOmittableShellReaders({
          sql,
          threadManagement: store as never,
          latestSequence: Effect.succeed(1),
        });
        const result = yield* readers.readThreadFamily({
          threadId: root,
          lookupThreadIds: [active.id, archived.id, deleted.id, ThreadId.make("thread:unknown")],
        });
        assert.deepEqual("lookupTitles" in result ? result.lookupTitles : null, {
          [active.id]: "Title active",
          [archived.id]: "Title archived",
        });
        const lookupOnly = yield* readers.readThreadFamily({
          threadId: root,
          lookupThreadIds: [active.id, archived.id, deleted.id],
          lookupOnly: true,
        });
        assert.deepEqual(lookupOnly.threads, []);
        assert.deepEqual("lookupTitles" in lookupOnly ? lookupOnly.lookupTitles : null, {
          [active.id]: "Title active",
          [archived.id]: "Title archived",
        });
        const legacy = yield* readers.readThreadFamily({ threadId: root });
        assert.isFalse("lookupTitles" in legacy);
      }),
  );

  it.effect(
    "a fork's family read brings its live source and leaves out deleted and archived threads",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const providerInstanceId = ProviderInstanceId.make("codex");
        const create = Effect.fn("test.createFamilyThread")(function* (
          name: string,
          root: ThreadId,
          state: { readonly archived?: boolean; readonly deleted?: boolean } = {},
        ) {
          const threadId = ThreadId.make(`thread:${name}`);
          const thread = {
            createdBy: "user" as const,
            creationSource: "web" as const,
            id: threadId,
            projectId: ProjectId.make("project:fork-family"),
            title: name,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: threadId === root ? null : root,
              relationshipToParent: threadId === root ? null : ("fork" as const),
              rootThreadId: root,
            },
            forkedFrom:
              threadId === root ? null : { type: "run" as const, threadId: root, runId: "run-1" },
            createdAt: now,
            updatedAt: now,
            archivedAt: state.archived ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* store.apply({
            id: EventId.make(`event:${name}:create`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread as never,
          });
          if (state.deleted) {
            yield* store.apply({
              id: EventId.make(`event:${name}:delete`),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: { ...thread, deletedAt: now } as never,
            });
          }
          return threadId;
        });
        const readers = makeOmittableShellReaders({
          sql,
          threadManagement: store as never,
          latestSequence: Effect.succeed(1),
        });
        const familyIds = (threadId: ThreadId) =>
          readers
            .readThreadFamily({ threadId })
            .pipe(Effect.map(({ threads }) => threads.map(({ id }) => id).toSorted()));

        const source = ThreadId.make("thread:source");
        yield* create("source", source);
        const fork = yield* create("fork", source);
        yield* create("archived-fork", source, { archived: true });
        yield* create("deleted-fork", source, { deleted: true });
        assert.deepEqual(yield* familyIds(fork), [fork, source].toSorted());

        const archivedSource = ThreadId.make("thread:archived-source");
        yield* create("archived-source", archivedSource, { archived: true });
        const forkOfArchived = yield* create("fork-of-archived", archivedSource);
        assert.deepEqual(yield* familyIds(forkOfArchived), [forkOfArchived]);
      }),
  );

  it.effect(
    "a lookup names each live or archived thread's project, and no project when it is gone",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const providerInstanceId = ProviderInstanceId.make("codex");
        const live = ProjectId.make("project:link-live");
        const removed = ProjectId.make("project:link-removed");
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${live},'live','/live','[]','2026-11-17','2026-11-17')`;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at) VALUES (${removed},'removed','/removed','[]','2026-11-17','2026-11-17','2026-11-17')`;
        const create = Effect.fn("test.createLinkedThread")(function* (
          name: string,
          projectId: ProjectId,
          state: { readonly archived?: boolean; readonly deleted?: boolean } = {},
        ) {
          const threadId = ThreadId.make(`thread:link-${name}`);
          const thread = {
            createdBy: "user" as const,
            creationSource: "web" as const,
            id: threadId,
            projectId,
            title: `Linked ${name}`,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: state.archived ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* store.apply({
            id: EventId.make(`event:link-${name}:create`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread as never,
          });
          if (state.deleted) {
            yield* store.apply({
              id: EventId.make(`event:link-${name}:delete`),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: { ...thread, deletedAt: now } as never,
            });
          }
          return threadId;
        });
        const active = yield* create("active", live);
        const archived = yield* create("archived", live, { archived: true });
        const orphan = yield* create("orphan", removed);
        const deleted = yield* create("deleted", live, { deleted: true });
        const readers = makeOmittableShellReaders({
          sql,
          threadManagement: store as never,
          latestSequence: Effect.succeed(1),
        });
        const result = yield* readers.readThreadFamily({
          threadId: active,
          lookupThreadIds: [
            active,
            archived,
            orphan,
            deleted,
            ThreadId.make("thread:link-unknown"),
          ],
          lookupOnly: true,
        });
        assert.deepEqual("lookupProjectIds" in result ? result.lookupProjectIds : null, {
          [active]: live,
          [archived]: live,
          [orphan]: null,
        });
        assert.deepEqual(
          Object.keys("lookupTitles" in result ? (result.lookupTitles ?? {}) : {}).toSorted(),
          [active, archived, orphan].toSorted(),
        );
      }),
  );
});
