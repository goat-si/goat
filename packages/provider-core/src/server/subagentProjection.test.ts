import { expect, it } from "@effect/vitest";
import { NodeId, OrchestrationV2AppThread, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { makeSubagentChildThread } from "./subagentProjection.ts";

const decodeAppThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);

it("does not inherit a launched parent's launcher into native children", () => {
  const now = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
  const parentId = ThreadId.make("parent");
  const instanceId = ProviderInstanceId.make("codex");
  const parent = decodeAppThread({
    createdBy: "agent",
    creationSource: "mcp",
    id: parentId,
    projectId: "project",
    title: "Parent",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
    launchedBy: {
      kind: "launch" as const,
      environmentLabel: null,
      threadTitle: null,
      threadId: "grandparent",
      environmentId: null,
      via: "thread_launch",
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  const child = makeSubagentChildThread({
    parentThread: parent,
    childThreadId: ThreadId.make("native-child"),
    parentNodeId: NodeId.make("node"),
    activeProviderThreadId: null,
    providerInstanceId: instanceId,
    modelSelection: parent.modelSelection,
    title: "Native child",
    now,
    createdBy: "agent",
    creationSource: "provider",
  });
  expect(child.launchedBy).toBeUndefined();
  expect(child.lineage).toEqual({
    parentThreadId: parentId,
    relationshipToParent: "subagent",
    rootThreadId: parentId,
  });
  expect(parent.launchedBy?.threadId).toBe("grandparent");
});
