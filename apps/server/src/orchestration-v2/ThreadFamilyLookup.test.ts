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
});
