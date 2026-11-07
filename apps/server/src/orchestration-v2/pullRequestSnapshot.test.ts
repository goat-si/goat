import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

it.layer(layer)("pull request snapshot", (it) => {
  it.effect(
    "reads only PR metadata and its sequence in one transaction, with targeted and settled filtering",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:pr-snapshot");
        const instanceId = ProviderInstanceId.make("codex");
        yield* store.apply({
          id: EventId.make("event:pr-snapshot"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:pr-snapshot"),
            title: "PR",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const reference = {
          projectId: "project:pr-snapshot",
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        };
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.linkedPullRequest', json(${JSON.stringify(reference)})) WHERE thread_id = ${threadId}`;
        const statements: string[] = [];
        const transactions: Array<string | null> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query !== "string") return;
              statements.push(query);
              let parent = Option.getOrUndefined(span.parent);
              while (parent?._tag === "Span" && parent.name !== "sql.transaction")
                parent = Option.getOrUndefined(parent.parent);
              transactions.push(parent?._tag === "Span" ? parent.spanId : null);
            };
            return span;
          },
        });
        const snapshot = yield* store.getPullRequestSnapshot({}).pipe(Effect.withTracer(tracer));
        assert.strictEqual(snapshot.snapshotSequence, 0);
        assert.lengthOf(snapshot.threads, 1);
        assert.strictEqual(transactions.length, 2);
        assert.isNotNull(transactions[0]);
        assert.strictEqual(new Set(transactions).size, 1);
        assert.isFalse(
          statements.some((query) =>
            /orchestration_v2_projection_(runs|messages|turn_items|provider_threads)/.test(query),
          ),
        );
        const full = (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.isDefined(full);
        for (const [key, value] of Object.entries(snapshot.threads[0] ?? {}))
          assert.deepEqual(value, Reflect.get(full!, key));
        assert.deepEqual(
          (yield* store.getPullRequestSnapshot({ threadId })).threads,
          snapshot.threads,
        );
        const setState = (settledAt: string | null, archivedAt: string | null) =>
          sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.settledAt', ${settledAt}, '$.archivedAt', ${archivedAt}) WHERE thread_id = ${threadId}`;
        yield* setState(DateTime.formatIso(now), null);
        assert.isEmpty((yield* store.getPullRequestSnapshot({ unsettledOnly: true })).threads);
        assert.lengthOf((yield* store.getPullRequestSnapshot({ threadId })).threads, 1);
        yield* setState(null, DateTime.formatIso(now));
        assert.isEmpty((yield* store.getPullRequestSnapshot({})).threads);
        assert.lengthOf((yield* store.getPullRequestSnapshot({ threadId })).threads, 1);
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-03T00:00:00.000Z' WHERE thread_id = ${threadId}`;
        assert.isEmpty((yield* store.getPullRequestSnapshot({ threadId })).threads);
      }),
  );
});
