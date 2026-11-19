import { NodeId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "./ProjectionStore.ts";
import { isAppOwnedDelegatedThread } from "./DelegatedThreadProvenance.ts";

it.effect("only recognizes a child backed by the matching app-owned delegated task", () =>
  Effect.gen(function* () {
    const childId = ThreadId.make("thread:delegated-task:caller-controlled");
    const parentId = ThreadId.make("parent");
    const taskId = NodeId.make("task");
    const store = (relationship: string | null, childThreadId: ThreadId, origin: string) =>
      ({
        getThreadRecords: (id: ThreadId) =>
          Effect.succeed(
            id === childId
              ? {
                  thread: {
                    lineage: { parentThreadId: parentId, relationshipToParent: relationship },
                    forkedFrom: { type: "node", nodeId: taskId },
                  },
                }
              : { subagents: [{ id: taskId, origin, childThreadId }] },
          ),
      }) as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    assert.isFalse(yield* isAppOwnedDelegatedThread(store(null, childId, "app_owned"), childId));
    assert.isFalse(
      yield* isAppOwnedDelegatedThread(
        store("subagent", ThreadId.make("other"), "app_owned"),
        childId,
      ),
    );
    assert.isFalse(yield* isAppOwnedDelegatedThread(store("subagent", childId, "native"), childId));
    assert.isTrue(
      yield* isAppOwnedDelegatedThread(store("subagent", childId, "app_owned"), childId),
    );
  }),
);
