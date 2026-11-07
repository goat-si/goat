import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { awarenessThread } from "./ProjectionAwareness.ts";

it.effect.each(["sqlite", "memory"] as const)(
  "reads only listed active awareness threads with $0 projections",
  (mode) => {
    const layer =
      mode === "sqlite"
        ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
        : ProjectionStore.layerMemory;
    return Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const rootId = ThreadId.make("awareness-root");
      const create = (id: ThreadId, overrides: Partial<OrchestrationV2AppThread> = {}) => {
        const thread: OrchestrationV2AppThread = {
          id,
          projectId: ProjectId.make("awareness-project"),
          title: id,
          createdBy: "user",
          creationSource: "web",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
          ...overrides,
        };
        return store.apply({
          id: EventId.make(`event-${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: thread,
        });
      };
      const childId = ThreadId.make("awareness-child");
      const sideId = ThreadId.make("awareness-side");
      const archivedId = ThreadId.make("awareness-archived");
      yield* create(rootId);
      yield* create(childId, {
        lineage: { parentThreadId: rootId, relationshipToParent: "subagent", rootThreadId: rootId },
      });
      yield* create(sideId, { sideChatOf: rootId });
      yield* create(archivedId, { archivedAt: now });
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      const snapshot = yield* store.getAgentAwarenessSnapshot().pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        snapshot.threads.map((thread) => thread.id),
        [rootId],
      );
      const shell = yield* store.getThreadShell(rootId);
      assert.isNotNull(shell);
      if (shell) assert.deepEqual(snapshot.threads[0], awarenessThread(shell));
      assert.equal((yield* store.getAgentAwarenessSnapshot(childId)).threads[0]?.id, childId);
      assert.equal((yield* store.getAgentAwarenessSnapshot(archivedId)).threads[0]?.id, archivedId);
      assert.isEmpty((yield* store.getAgentAwarenessSnapshot(ThreadId.make("missing"))).threads);
      if (mode === "sqlite")
        assert.isFalse(statements.some((query) => /COUNT\(\*\) AS item_count/i.test(query)));
    }).pipe(Effect.provide(Layer.merge(layer, SqlitePersistence.layerMemory)));
  },
);
