import {
  EventId,
  NodeId,
  RuntimeRequestId,
  ProviderSessionId,
  type OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { boundedSnapshotProjection } from "@goat/shared/orchestrationV2BoundedSnapshot";

import {
  buildBoundedThreadStreamSnapshot,
  boundedSnapshotResponseFields,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES,
  THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./ThreadStream.ts";
import { buildBoundedThreadProjection, decodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import { projectDomainEventForWire, projectThreadProjectionForWire } from "./WireProjection.ts";

const NOW = DateTime.makeUnsafe("2026-09-08T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-stream-test");
const LARGE_PROJECTABLE_OUTPUT_BYTES = 10 * 1_048_576;
const LARGE_PROJECTABLE_RAW_PAYLOAD_BYTES = 10_486_214;
const MAX_PROJECTED_DYNAMIC_REPLAY_BYTES = 2_048;

function timelineProjection(itemCount: number): OrchestrationV2ThreadProjection {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = Array.from(
    { length: itemCount },
    (_, index) => {
      const id = TurnItemId.make(`item-${index}`);
      const item = {
        id,
        type: "command_execution",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed",
        title: `Command ${index}`,
        input: `command-${index}`,
        output: `output-${index}`,
        exitCode: 0,
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
      } satisfies OrchestrationV2TurnItem;
      return {
        position: index,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: id,
        item,
      };
    },
  );
  return {
    thread: {
      id: THREAD_ID,
      projectId: "project-stream-test",
      title: "Thread stream test",
      providerInstanceId: "codex",
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD_ID,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as OrchestrationV2ThreadProjection;
}

function pendingDecisionFixture() {
  const base = {
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "waiting" as const,
    title: null,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
  };
  const question = {
    ...base,
    id: TurnItemId.make("d10-question-item"),
    ordinal: 1,
    type: "user_input_request",
    requestId: RuntimeRequestId.make("d10-question"),
    responseMode: "message",
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Choose a destination",
        options: [{ label: "One", description: "First destination", value: "  native\t" }],
        multiSelect: false,
        allowCustomAnswer: true,
        initialAnswer: "  draft\n",
      },
    ],
  } satisfies OrchestrationV2TurnItem;
  const approval = {
    ...base,
    id: TurnItemId.make("d10-approval-item"),
    ordinal: 2,
    type: "approval_request",
    requestId: RuntimeRequestId.make("d10-approval"),
    requestKind: "command",
    prompt: "Run the requested command?",
    appName: "D10 fixture",
    options: [
      { decision: "acceptForSession", label: "Allow this session", warning: "Fixture caution" },
      { decision: "decline", label: "Decline" },
    ],
  } satisfies OrchestrationV2TurnItem;
  const requestBase = {
    nodeId: NodeId.make("d10-node"),
    providerTurnId: null,
    nativeRequestRef: null,
    status: "pending" as const,
    createdAt: NOW,
    resolvedAt: null,
  };
  const requests: OrchestrationV2RuntimeRequest[] = [
    {
      ...requestBase,
      id: question.requestId,
      kind: "user_input",
      responseCapability: { type: "message" },
    },
    {
      ...requestBase,
      id: approval.requestId,
      kind: "command",
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("d10-session"),
      },
    },
  ];
  return { question, approval, requests };
}

function pendingDecisionProjection() {
  const base = timelineProjection(80);
  const { question, approval, requests } = pendingDecisionFixture();
  const commands = base.visibleTurnItems.map((entry) => ({
    ...entry,
    item: { ...entry.item, ordinal: entry.item.ordinal + 2 },
  }));
  return {
    ...base,
    runtimeRequests: requests,
    turnItems: [question, approval, ...commands.map((entry) => entry.item)],
    visibleTurnItems: commands,
  };
}

describe("decideThreadResume", () => {
  it("replays when the event count is within the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 20_000,
        replayEventCount: THREAD_RESUME_MAX_REPLAY_EVENTS,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
      }),
    ).toEqual({
      mode: "replay",
      afterSequence: 10,
      throughSequence: 20_000,
    });
  });

  it("falls back to a snapshot when encoded replay bytes exceed the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 11,
        replayEventCount: 1,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES + 1,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("falls back to a snapshot when the client cursor is ahead of the store", () => {
    expect(
      decideThreadResume({
        afterSequence: 50,
        highWater: 40,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("builds socket fallback snapshots with a bounded timeline and history cursor", () => {
    const snapshot = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection: timelineProjection(80),
    });

    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.snapshotSequence).toBe(44);
    expect(snapshot.projection.visibleTurnItems).toHaveLength(75);
    expect(snapshot.projection.turnItems).toHaveLength(75);
    expect(snapshot.historyCursor).not.toBeNull();
    expect(snapshot.hasMoreHistory).toBe(true);
    expect(snapshot.latestLocalTurnOrdinal).toBe(80);
    expect(snapshot.payloadBudgetExceeded).toBe(false);
  });

  it("rejects a 10 MiB raw replay even when its projected form fits the wire budget", () => {
    const item = {
      id: TurnItemId.make("large-dynamic-tool"),
      type: "dynamic_tool",
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Large result",
      toolName: "mcp__test__large_result",
      input: { query: "small" },
      output: { text: "x".repeat(LARGE_PROJECTABLE_OUTPUT_BYTES) },
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    } satisfies OrchestrationV2TurnItem;
    const event = {
      id: EventId.make("large-dynamic-tool-event"),
      type: "turn-item.updated" as const,
      threadId: THREAD_ID,
      occurredAt: NOW,
      payload: item,
    };
    const rawReplay = [{ kind: "event" as const, sequence: 10, event }];
    const projectedReplay = [
      {
        kind: "event" as const,
        sequence: 10,
        event: projectDomainEventForWire(event),
      },
    ];

    const rawPayloadBytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
    expect(rawPayloadBytes).toBe(LARGE_PROJECTABLE_RAW_PAYLOAD_BYTES);
    expect(rawPayloadBytes).toBeGreaterThan(THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES);
    expect(isThreadReplayRawPayloadSafe(rawPayloadBytes)).toBe(false);
    expect(threadReplayEncodedBytes(rawReplay)).toBeGreaterThan(
      THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
    );
    const projectedBytes = threadReplayEncodedBytes(projectedReplay);
    expect(projectedBytes).toBeLessThanOrEqual(MAX_PROJECTED_DYNAMIC_REPLAY_BYTES);
    expect(
      decideThreadResume({
        afterSequence: 9,
        highWater: 10,
        replayEventCount: projectedReplay.length,
        replayEncodedBytes: projectedBytes,
      }),
    ).toEqual({ mode: "replay", afterSequence: 9, throughSequence: 10 });
  });
});

describe("compact bounded snapshots", () => {
  const FORK_PARENT = ThreadId.make("thread-stream-parent");
  const decodeStreamItem = Schema.decodeUnknownSync(
    Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
  );
  const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

  function forkProjection(): OrchestrationV2ThreadProjection {
    const base = timelineProjection(6);
    const local = base.visibleTurnItems.slice(3).map((row, index) => ({ ...row, position: index }));
    const inherited = base.visibleTurnItems.slice(0, 3).map((row, index) => {
      const item = { ...row.item, id: TurnItemId.make(`parent-${index}`), threadId: FORK_PARENT };
      return {
        position: index,
        visibility: "inherited" as const,
        sourceThreadId: FORK_PARENT,
        sourceItemId: item.id,
        item,
      };
    });
    const request = {
      ...base.turnItems[0]!,
      id: TurnItemId.make("interrupt-request"),
      type: "run_interrupt_request",
      ordinal: 0,
      message: "Stop",
    } as unknown as OrchestrationV2TurnItem;
    return {
      ...base,
      turnItems: [request, ...local.map((row) => row.item)],
      visibleTurnItems: [...inherited, ...local].map((row, position) => ({ ...row, position })),
    };
  }

  it.each([
    ["linear", () => timelineProjection(80)],
    ["fork with retained interrupt request", forkProjection],
    ["pending question and approval dependencies", pendingDecisionProjection],
  ])("restores the exact opted-out snapshot for %s threads", (_, makeProjection) => {
    const base = makeProjection();
    const projection = {
      ...base,
      thread: { ...base.thread, modelSelection: { instanceId: "codex", model: "gpt-5" } },
    } as OrchestrationV2ThreadProjection;
    const full = buildBoundedThreadStreamSnapshot({ snapshotSequence: 44, projection });
    const compact = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 44,
      projection,
      compactTurnItems: true,
    });

    expect("turnItemsOmitLocalVisible" in full).toBe(false);
    expect(compact.turnItemsOmitLocalVisible).toBe(true);
    expect(compact.projection.turnItems.length).toBeLessThan(full.projection.turnItems.length);
    const { turnItemsOmitLocalVisible: _marker, ...compactFields } = compact;
    expect({ ...compactFields, projection: full.projection }).toEqual(full);

    const decodedFull = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(full))));
    const decodedCompact = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(compact))));
    if (decodedFull.kind !== "snapshot" || decodedCompact.kind !== "snapshot") {
      throw new Error("Expected snapshots");
    }
    const restored = boundedSnapshotProjection(decodedCompact);
    expect(restored).toEqual(decodedFull.projection);
    if (base.runtimeRequests.length > 0) {
      const { question, approval } = pendingDecisionFixture();
      expect(compact.projection.turnItems).toEqual([question, approval]);
      expect(restored.turnItems.filter((item) => item.type === "user_input_request")).toEqual([
        question,
      ]);
      expect(restored.turnItems.filter((item) => item.type === "approval_request")).toEqual([
        approval,
      ]);
      expect(new Set(restored.turnItems.map((item) => item.id)).size).toBe(
        restored.turnItems.length,
      );
      expect(
        restored.visibleTurnItems.every((entry) => entry.item.type === "command_execution"),
      ).toBe(true);
      expect(
        restored.visibleTurnItems.some(
          (entry) => entry.sourceItemId === question.id || entry.sourceItemId === approval.id,
        ),
      ).toBe(false);
      expect(full.hasMoreHistory).toBe(true);
      expect(compact.hasMoreHistory).toBe(true);
      expect(compact.historyCursor).toBe(full.historyCursor);
      expect(restored.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual(
        Array.from({ length: 75 }, (_, index) => `item-${index + 5}`),
      );
      expect(decodeThreadHistoryCursor(full.historyCursor!).si).toBe("item-5");
      // The HTTP snapshot loader wire-projects before building the bounded response.
      const bounded = buildBoundedThreadProjection({
        projection: projectThreadProjectionForWire(projection),
        snapshotSequence: 44,
      });
      const fields = boundedSnapshotResponseFields({ bounded, compactTurnItems: true });
      const fullFields = boundedSnapshotResponseFields({ bounded, compactTurnItems: false });
      expect(fields.historyCursor).toBe(full.historyCursor);
      expect(fullFields.historyCursor).toBe(full.historyCursor);
      expect(fields.hasMoreHistory).toBe(true);
      expect(fullFields.hasMoreHistory).toBe(true);
      expect(fields.projection.turnItems).toEqual([question, approval]);
      expect(boundedSnapshotProjection(fields)).toEqual(fullFields.projection);
      expect(fields.projection.visibleTurnItems).toEqual(full.projection.visibleTurnItems);
    }
  });
});
