import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TerminalThreadWorktree } from "../../terminal/TerminalThreadWorktree.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import {
  D10_NOW,
  layerTest,
  modelSelection,
  providerInstanceId,
} from "../ProjectionStore.testkit.ts";
import * as TerminalThreadWorktreeLive from "./terminalThreadWorktree.ts";

const threadPayload = (id: ThreadId, worktreePath: string | null) => ({
  createdBy: "user" as const,
  creationSource: "web" as const,
  id,
  projectId: ProjectId.make("project:terminal-worktree"),
  title: "Terminal worktree",
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: D10_NOW,
  updatedAt: D10_NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

it.effect(
  "the live worktree read follows the projection: gone when unknown or deleted, else the binding",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const worktrees = yield* TerminalThreadWorktree;
      const create = (suffix: string, worktreePath: string | null) =>
        Effect.gen(function* () {
          const id = ThreadId.make(`thread:${suffix}`);
          const payload = threadPayload(id, worktreePath);
          yield* store.apply({
            id: EventId.make(`event:${suffix}:created`),
            type: "thread.created",
            threadId: id,
            occurredAt: D10_NOW,
            payload,
          });
          return { id, payload };
        });
      assert.isTrue(Option.isNone(yield* worktrees.current("thread:unknown")));
      const unbound = yield* create("unbound", null);
      assert.deepEqual(yield* worktrees.current(unbound.id), Option.some(null));
      const bound = yield* create("bound", "/worktrees/repo/feature");
      assert.deepEqual(yield* worktrees.current(bound.id), Option.some("/worktrees/repo/feature"));
      yield* store.apply({
        id: EventId.make("event:bound:deleted"),
        type: "thread.deleted",
        threadId: bound.id,
        occurredAt: D10_NOW,
        payload: { ...bound.payload, deletedAt: D10_NOW },
      });
      assert.isTrue(Option.isNone(yield* worktrees.current(bound.id)));
    }).pipe(Effect.provide(TerminalThreadWorktreeLive.layer.pipe(Layer.provideMerge(layerTest)))),
);
