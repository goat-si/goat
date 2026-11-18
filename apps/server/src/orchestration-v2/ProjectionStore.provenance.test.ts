import { PlanId } from "@goat/contracts";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  NodeId,
  ProjectId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";

import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
  encodeUnknownJsonString,
  D10_NOW,
  createD10Thread,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

it.effect(
  "retains launcher and response provenance in persisted payloads and both shell paths",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const launcher = {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        threadId: ThreadId.make("caller"),
        environmentId: EnvironmentId.make("origin"),
        via: "create_threads" as const,
      };
      for (const hasLauncher of [false, true]) {
        const threadId = ThreadId.make(`foundation-${hasLauncher}`);
        const thread = {
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          id: threadId,
          projectId: ProjectId.make("foundation-project"),
          title: "Foundation",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
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
          ...(hasLauncher ? { launchedBy: launcher } : {}),
        };
        yield* store.apply({
          id: EventId.make(`foundation-thread-${hasLauncher}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        });
        const requestId = RuntimeRequestId.make(`foundation-request-${hasLauncher}`);
        const nodeId = NodeId.make(`foundation-node-${hasLauncher}`);
        const respondedBy = {
          type: "agent" as const,
          threadId: ThreadId.make("responder"),
          environmentId: null,
          title: "Coordinator",
          reason: "  Saved reason  ",
        };
        const answers = { q: "  Exact option  " };
        const request = {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "resolved" as const,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: now,
          respondedBy,
          answers,
        };
        yield* store.apply({
          id: EventId.make(`foundation-request-event-${hasLauncher}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: request,
        });
        yield* store.apply({
          id: EventId.make(`foundation-item-event-${hasLauncher}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`foundation-item-${hasLauncher}`),
            type: "user_input_request",
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            requestId,
            questions: [],
            questionAnswer: { requestId, respondedBy, answers, attachmentsByQuestionId: {} },
          },
        });
        const projection = yield* store.getThreadProjection(threadId);
        const expected = hasLauncher ? launcher : undefined;
        assert.deepEqual(projection.thread.launchedBy, expected);
        assert.deepEqual(
          ProjectionStore.threadShellFromProjection(projection).launchedBy,
          expected,
        );
        assert.deepEqual((yield* store.getThreadShell(threadId))?.launchedBy, expected);
        assert.deepEqual(
          (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
            ?.launchedBy,
          expected,
        );
        assert.deepEqual(projection.runtimeRequests[0]?.respondedBy, respondedBy);
        const item = projection.turnItems[0];
        assert.equal(item?.type, "user_input_request");
        if (item?.type === "user_input_request")
          assert.deepEqual(item.questionAnswer?.respondedBy, respondedBy);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        assert.deepEqual(JSON.parse(rows[0]!.payload_json).launchedBy, expected);
        const requests = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ${requestId}`;
        assert.deepEqual(JSON.parse(requests[0]!.payload_json).respondedBy, respondedBy);
        const items = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
        assert.deepEqual(
          JSON.parse(items[0]!.payload_json).questionAnswer.respondedBy,
          respondedBy,
        );
        yield* store.apply({
          id: EventId.make(`foundation-archive-${hasLauncher}`),
          type: "thread.archived",
          threadId,
          occurredAt: now,
          payload: { ...projection.thread, archivedAt: now },
        });
        assert.deepEqual((yield* store.getThreadProjection(threadId)).thread.launchedBy, expected);
      }
    }).pipe(Effect.provide(layerTest)),
);

// goat-rename: legacy-begin
it.effect("discovers persisted MCP app attachments under either peer output key", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("peer-apps");
    const ids: string[] = [];
    for (const key of ["t3McpApp", "goatMcpApp"]) {
      const attachmentId = createDeterministicAttachmentId(threadId, key)!;
      ids.push(attachmentId);
      const payload = {
        toolName: "weather.get",
        output: {
          [key]: { attachmentId, server: "weather", tool: "get", resourceUri: "ui://weather" },
        },
      };
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES (${key}, ${threadId}, ${ids.length}, 'dynamic_tool', 'completed', '2026-10-13T00:00:00Z', ${encodeUnknownJsonString(payload)})`;
    }
    assert.deepEqual((yield* store.getThreadAttachmentIds(threadId)).toSorted(), ids.toSorted());
  }).pipe(Effect.provide(layerTest)),
);
// goat-rename: legacy-end

it.effect(
  "SQL and memory page review history by entry time and preserve it through omitted provider fields",
  () => {
    const verify = Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createD10Thread("review-ledger");
      const task = {
        memoryGrantCeiling: "none",
        id: NodeId.make("review-task"),
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent-node"),
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Review",
        title: null,
        model: "reviewer",
        role: "review",
        status: "running",
        result: null,
        startedAt: D10_NOW,
        completedAt: null,
        updatedAt: D10_NOW,
        completionDelivery: { state: "pending", observedByRunId: null },
        reviewLedger: [
          {
            kind: "decision",
            entryId: "first",
            findingId: "finding",
            severity: "high",
            cites: null,
            summary: "Check",
            decision: "rebutted",
            evidence: { kind: "test", ref: "guard.test.ts" },
            recordedAt: "2026-10-16T00:00:00.000Z",
            recordedByRunId: null,
          },
          {
            kind: "decision",
            entryId: "second",
            findingId: "other",
            severity: "low",
            cites: null,
            summary: "Fix",
            decision: "accepted",
            evidence: null,
            recordedAt: "2026-10-16T12:00:00.000Z",
            recordedByRunId: null,
          },
          {
            kind: "outcome",
            entryId: "third",
            findingId: "finding",
            outcome: "later_confirmed",
            link: { kind: "test", ref: "failing.test.ts" },
            recordedAt: "2026-10-17T00:00:00.000Z",
            recordedByRunId: null,
          },
        ],
      } satisfies OrchestrationV2Subagent;
      yield* store.apply({
        id: EventId.make("review-task-created"),
        type: "subagent.updated",
        threadId,
        occurredAt: D10_NOW,
        payload: task,
      });
      // A provider snapshot without app bookkeeping must not erase the ledger.
      yield* store.apply({
        id: EventId.make("review-task-progress"),
        type: "subagent.updated",
        threadId,
        occurredAt: D10_NOW,
        payload: {
          ...task,
          reviewLedger: undefined,
          completionDelivery: undefined,
          progress: "Still reviewing",
        },
      });
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["subagents"], {
          subagentIds: [NodeId.make("missing-task")],
        })).subagents,
        [],
      );
      assert.equal(
        (yield* store.getThreadRecords(threadId, ["subagents"], { subagentIds: [task.id] }))
          .subagents[0]?.id,
        task.id,
      );
      const persisted = (yield* store.getThreadRecords(threadId, ["subagents"])).subagents[0]!;
      assert.deepEqual(persisted.reviewLedger, task.reviewLedger);
      assert.deepEqual(persisted.completionDelivery, task.completionDelivery);
      const range = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", limit: 1 };
      const first = yield* store.getReviewLedgerEntries(range);
      assert.deepEqual(
        first.map(({ index }) => index),
        [0],
      );
      const second = yield* store.getReviewLedgerEntries({
        ...range,
        cursor: { taskId: task.id, index: 0 },
      });
      assert.deepEqual(
        second.map(({ index }) => index),
        [1],
      );
      assert.deepEqual(
        yield* store.getReviewLedgerEntries({ ...range, cursor: { taskId: task.id, index: 1 } }),
        [],
      );
      const atBoundary = yield* store.getReviewLedgerEntries({
        from: range.to,
        to: "2026-10-18T00:00:00.000Z",
        limit: 10,
      });
      assert.deepEqual(
        atBoundary.map(({ index }) => index),
        [2],
      );
      const thread = yield* store.getThread(threadId);
      yield* store.apply({
        id: EventId.make("archive-review-parent"),
        type: "thread.archived",
        threadId,
        occurredAt: D10_NOW,
        payload: { ...thread, archivedAt: D10_NOW },
      });
      assert.lengthOf(yield* store.getReviewLedgerEntries(range), 1);
      yield* store.apply({
        id: EventId.make("delete-review-parent"),
        type: "thread.deleted",
        threadId,
        occurredAt: D10_NOW,
        payload: { ...thread, deletedAt: D10_NOW },
      });
      assert.deepEqual(yield* store.getReviewLedgerEntries(range), []);
      return persisted.reviewLedger;
    });
    return Effect.gen(function* () {
      const sql = yield* verify.pipe(Effect.provide(layerTest));
      const memory = yield* verify.pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.deepEqual(sql, memory);
    });
  },
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells flag only an active turn blocked solely on GOAT thread waits", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("thread-wait");
    const initial = yield* store.getThreadProjection(threadId);
    const at = initial.updatedAt;
    const previousCommand = initial.turnItems.find((item) => item.type === "command_execution")!;
    const itemBase = {
      ...previousCommand,
      providerThreadId: previousCommand.providerThreadId ?? null,
      providerTurnId: previousCommand.providerTurnId ?? null,
      nativeItemRef: previousCommand.nativeItemRef ?? null,
      parentItemId: previousCommand.parentItemId ?? null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:previous-completed"),
      type: "run.updated",
      threadId,
      occurredAt: at,
      payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
    });
    const run = {
      ...initial.runs[0]!,
      id: RunId.make("run:thread-wait:active"),
      ordinal: 2,
      status: "running" as const,
      completedAt: null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:active"),
      type: "run.created",
      threadId,
      occurredAt: at,
      payload: run,
    });
    let sequence = 0;
    const updateItem = (payload: OrchestrationV2TurnItem) =>
      store.apply({
        id: EventId.make(`event:thread-wait:item:${sequence++}`),
        type: "turn-item.updated",
        threadId,
        runId: payload.runId ?? undefined,
        driver,
        occurredAt: at,
        payload,
      });
    const assertBlocked = Effect.fnUntraced(function* (expected: boolean) {
      const listed = (yield* store.getShellSnapshot()).threads.find((row) => row.id === threadId);
      for (const shell of [yield* store.getThreadShell(threadId), listed]) {
        assert.equal(shell?.activeRunId, run.id);
        assert.equal(shell?.status, "running");
        assert.equal(shell?.blockedOnThreadWait ?? false, expected);
      }
    });
    const wait = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:active"),
      runId: run.id,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3_code__t3_thread_wait",
      input: { threadId: "child-thread" },
      status: "running" as const,
    };

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:stale"),
      runId: initial.runs[0]!.id,
    });
    yield* assertBlocked(false);
    const foreign = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:foreign"),
      toolName: "weather.t3_thread_wait",
    };
    yield* updateItem(foreign);
    yield* assertBlocked(false);
    yield* updateItem({ ...foreign, status: "completed", completedAt: at });
    yield* updateItem({ ...wait, status: "pending", startedAt: null });
    yield* assertBlocked(false);
    yield* updateItem(wait);
    yield* assertBlocked(true);

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:plan"),
      type: "todo_list",
      planId: PlanId.make("plan:thread-wait"),
      steps: [{ id: "review", text: "Review the child result", status: "running" }],
    });
    yield* assertBlocked(true);
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:proposed-plan"),
      type: "proposed_plan",
      planId: PlanId.make("plan:thread-wait:proposed"),
      markdown: "Review the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-message"),
      nativeItemRef: { driver, nativeId: "named-message", strength: "weak" },
      type: "assistant_message",
      messageId: MessageId.make("message:thread-wait:named"),
      text: "Waiting for the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-thought"),
      nativeItemRef: { driver, nativeId: "named-thought", strength: "weak" },
      type: "reasoning",
      text: "I need the child result",
      streaming: true,
    });
    yield* assertBlocked(true);

    const command = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:concurrent"),
      runId: run.id,
    };
    yield* updateItem(command);
    yield* assertBlocked(false);
    yield* updateItem({ ...wait, status: "waiting" });
    yield* assertBlocked(false);
    yield* updateItem({ ...command, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const fileChange = {
      ...command,
      id: TurnItemId.make("item:thread-wait:concurrent-edit"),
      type: "file_change" as const,
      fileName: "example.ts",
    };
    yield* updateItem(fileChange);
    yield* assertBlocked(false);
    yield* updateItem({ ...fileChange, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const compaction = {
      ...command,
      id: TurnItemId.make("item:thread-wait:compaction"),
      type: "compaction" as const,
      driver,
    };
    yield* updateItem(compaction);
    yield* assertBlocked(false);
    yield* updateItem({ ...compaction, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    yield* updateItem({ ...wait, status: "completed", completedAt: at });
    yield* assertBlocked(false);

    const delegation = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:delegation"),
      toolName: "goat-thread_opencode2-adapter_delegate_task",
      input: { task: "Review", mode: "async" },
    };
    yield* updateItem(delegation);
    yield* assertBlocked(false);
    yield* updateItem({ ...delegation, status: "completed", completedAt: at });
    const blockingDelegation = {
      ...delegation,
      id: TurnItemId.make("item:thread-wait:blocking-delegation"),
      input: { task: "Review", mode: "wait" },
    };
    yield* updateItem({
      ...command,
      id: TurnItemId.make("item:thread-wait:child"),
      type: "subagent",
      subagentId: NodeId.make("node:thread-wait:child"),
      origin: "app_owned",
      driver,
      providerInstanceId,
      childThreadId: ThreadId.make("child-thread"),
      prompt: "Review",
      result: null,
    });
    yield* updateItem(blockingDelegation);
    yield* assertBlocked(true);
    yield* updateItem({ ...blockingDelegation, status: "completed", completedAt: at });
    yield* assertBlocked(false);
  }).pipe(Effect.provide(layer)),
);
