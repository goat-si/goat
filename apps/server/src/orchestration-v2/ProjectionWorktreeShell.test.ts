import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  modelSelection,
  providerInstanceId,
  traceSqlStatements,
} from "./ProjectionStore.testkit.ts";

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells read a subagent family and a worktree's threads", ([kind, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:family");
    const worktreePath = "/repo/.t3/worktrees/family";
    const id = (name: string) => ThreadId.make(`thread:family:${name}`);
    const payloadOf = (input: {
      readonly name: string;
      readonly parent?: string;
      readonly root?: string;
      readonly worktreePath?: string;
      readonly archived?: boolean;
    }) =>
      ({
        createdBy: "user",
        creationSource: input.parent === undefined ? "web" : "mcp",
        id: id(input.name),
        projectId,
        title: input.name,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: input.worktreePath ?? null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.parent === undefined ? null : id(input.parent),
          relationshipToParent: input.parent === undefined ? null : "subagent",
          rootThreadId: id(input.root ?? input.name),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }) as const;
    const createThread = (input: Parameters<typeof payloadOf>[0]) =>
      store.apply({
        id: EventId.make(`event:family:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: payloadOf(input),
      });
    yield* createThread({ name: "root", worktreePath });
    yield* createThread({ name: "child", parent: "root", root: "root", worktreePath });
    yield* createThread({ name: "grandchild", parent: "child", root: "root" });
    yield* createThread({ name: "archived-child", parent: "root", root: "root", archived: true });
    yield* createThread({ name: "other", worktreePath: "/repo" });
    yield* createThread({ name: "other-child", parent: "other", root: "other", worktreePath });
    yield* createThread({
      name: "aliased-child",
      parent: "other",
      root: "other",
      worktreePath: `${worktreePath}/`,
    });
    yield* createThread({ name: "cased", worktreePath: worktreePath.toUpperCase() });
    yield* createThread({ name: "windows", worktreePath: "C:\\Répo\\WT" });
    const family = (threadId: ThreadId) =>
      store
        .getShellSnapshot({ location: "active", familyOf: threadId })
        .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));
    // Any member, or the root itself, names the same active tree, root included.
    const tree = [id("root"), id("child"), id("grandchild")];
    assert.sameMembers([...(yield* family(id("root")))], tree);
    assert.sameMembers([...(yield* family(id("grandchild")))], tree);
    assert.deepEqual([...(yield* family(id("missing")))], []);
    // Includes another root's idle child on the same path, which a shell may leave out.
    const { statements, tracer } = traceSqlStatements();
    const onWorktree = yield* store
      .getShellSnapshot({ location: "active", worktreePath })
      .pipe(Effect.withTracer(tracer));
    assert.sameMembers(
      onWorktree.threads.map((thread) => thread.id),
      [id("root"), id("child"), id("other-child"), id("aliased-child")],
    );
    const windows = yield* store.getShellSnapshot({
      location: "active",
      worktreePath: "c:/Répo/wt/",
    });
    assert.deepEqual(
      windows.threads.map((thread) => thread.id),
      [id("windows")],
    );
    // A path names a few threads; scanning every thread parses every payload.
    const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (kind === "SQL") {
      const sql = Option.getOrThrow(sqlClient);
      const threadQuery = statements.find((statement) =>
        statement.includes("AS latest_run_stop_requested"),
      );
      assert.isDefined(threadQuery);
      const threadPlan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${threadQuery}`,
        [],
      )).map((row) => row.detail);
      assert.notInclude(threadPlan, "SCAN t", threadPlan.join("\n"));
    }
    // A fork keeps its deleted source's root, so the deleted root still names the live tree.
    yield* store.apply({
      id: EventId.make("event:family:root-deleted"),
      type: "thread.deleted",
      threadId: id("root"),
      occurredAt: now,
      payload: { ...payloadOf({ name: "root", worktreePath }), deletedAt: now },
    });
    assert.sameMembers([...(yield* family(id("root")))], [id("child"), id("grandchild")]);
  }).pipe(Effect.provide(layer)),
);
