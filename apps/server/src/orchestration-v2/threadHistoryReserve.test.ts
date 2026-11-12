import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}

it("reserves dependency bytes before selecting the minimum timeline window", () => {
  const items = Array.from({ length: 10 }, (_, index) => makeRow(index, { outputBytes: 300 }));
  const base = makeProjection(items);
  const request = {
    ...interruptItem("old-request", "run_interrupt_request", 0),
    message: "r".repeat(3500),
  };
  const projection = {
    ...base,
    turnItems: [request, ...base.turnItems],
    checkpoints: [{ id: "checkpoint", files: ["c".repeat(9000)] }],
  } as unknown as typeof base;
  const bounded = buildBoundedThreadProjection({
    projection,
    snapshotSequence: 1,
    policy: { maxItems: 100, maxEncodedBytes: 10000 },
  });
  expect(bounded.projection.turnItems.some((item) => item.id === request.id)).toBe(true);
  expect(bounded.projection.visibleTurnItems.length).toBeLessThanOrEqual(2);
});

it.each([false, true])(
  "keeps agent-only turns visible when checkpoint file lists fill the byte budget (stored interrupt request: %s)",
  (withInterruptRequest) => {
    const items = Array.from({ length: 3 }, (_, turn) => {
      const first = makeRow(turn * 5);
      const prompt = {
        ...first,
        item: {
          ...first.item,
          type: "user_message" as const,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          inputIntent: "turn_start" as const,
          messageId: MessageId.make(`agent-prompt-${turn}`),
          text: `Step ${turn}`,
          attachments: [],
        },
      } as OrchestrationV2ProjectedTurnItem;
      return [prompt, ...Array.from({ length: 4 }, (_, index) => makeRow(turn * 5 + index + 1))];
    }).flat();
    const files = Array.from(
      { length: 15_000 },
      (_, index) =>
        `work/ws-${index % 40}/.jj/repo/store/extra/${index.toString(16).padStart(40, "0")}`,
    );
    const base = makeProjection(items);
    const projection = {
      ...base,
      turnItems: withInterruptRequest
        ? [interruptItem("old-interrupt-req", "run_interrupt_request", 0), ...base.turnItems]
        : base.turnItems,
      checkpoints: [{ id: "checkpoint-1", files }],
    } as unknown as ReturnType<typeof makeProjection>;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 1 });

    expect(bounded.projection.visibleTurnItems).toHaveLength(items.length);
    expect(bounded.hasMoreHistory).toBe(false);
  },
);
it("retains a waiting approval handoff outside the window and drops an answered one", () => {
  const handoff = (id: string, state: "pending" | "completed") => {
    const row = makeRow(0);
    return {
      ...row.item,
      id: TurnItemId.make(id),
      type: "human_handoff",
      status: state === "pending" ? "waiting" : "completed",
      handoff: {
        handoffId: TurnItemId.make(id),
        kind: "approval",
        title: `Approve ${id}`,
        reason: "Needed",
        requestedBy: { threadId: THREAD, providerInstanceId: null, path: "hub.device_join" },
        target: { environmentId: "env", path: "hub.device_join" },
        dedupeKey: id,
        state,
        expiresAt: null,
        createdAt: NOW,
        actor: { type: "agent", threadId: THREAD },
      },
    } as unknown as OrchestrationV2TurnItem;
  };
  const waiting = handoff("handoff-waiting", "pending");
  const answered = handoff("handoff-answered", "completed");
  const rows = [
    { ...makeRow(0), sourceItemId: waiting.id, item: waiting },
    { ...makeRow(1), sourceItemId: answered.id, item: answered },
    makeRow(2),
    makeRow(3),
  ] as OrchestrationV2ProjectedTurnItem[];
  const bounded = buildBoundedThreadProjection({
    projection: { ...makeProjection(rows), runs: [], attempts: [], runtimeRequests: [] },
    snapshotSequence: 1,
    policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
  });
  expect(bounded.projection.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
    "item-3",
  ]);
  expect(bounded.projection.turnItems.map((item) => item.id)).toEqual([
    "item-3",
    "handoff-waiting",
  ]);
});
