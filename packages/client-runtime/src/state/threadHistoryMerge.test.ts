import {
  NodeId,
  RuntimeRequestId,
  ProviderSessionId,
  RunId,
  MessageId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { mergeOlderHistoryIntoProjection } from "./threadHistoryMerge.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

function row(index: number): OrchestrationV2ProjectedTurnItem {
  const id = `item-${index}` as never;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: v2ThreadId,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: v2ThreadId,
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
      output: `out-${index}`,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function pendingDecisionFixture() {
  const base = {
    threadId: v2ThreadId,
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

describe("threadHistoryMerge", () => {
  it("fills activity around partial messages in canonical order and preserves live edits", () => {
    const initial = { ...v2Projection, turnItems: [row(4).item], visibleTurnItems: [row(4)] };
    const preview = [row(1), row(3)];
    const partial = mergeOlderHistoryIntoProjection(initial, preview);
    const updated = { ...row(1), item: { ...row(1).item, title: "newer live title" } };
    const live = {
      ...partial,
      visibleTurnItems: partial.visibleTurnItems.map((entry) =>
        entry.sourceItemId === updated.sourceItemId ? updated : entry,
      ),
      turnItems: partial.turnItems.map((item) =>
        item.id === updated.item.id ? updated.item : item,
      ),
    };
    const complete = mergeOlderHistoryIntoProjection(live, [row(0), row(1), row(2), row(3)]);
    expect(complete.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
    ]);
    expect(complete.visibleTurnItems[1]?.item).toBe(updated.item);
    expect(complete.visibleTurnItems.map((entry) => entry.position)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(complete.turnItems.map((item) => item.id)).size).toBe(5);
    const hidden = {
      ...partial,
      visibleTurnItems: partial.visibleTurnItems.filter(
        (entry) => entry.sourceItemId !== preview[0]!.sourceItemId,
      ),
    };
    const hiddenComplete = mergeOlderHistoryIntoProjection(hidden, [
      row(0),
      row(1),
      row(2),
      row(3),
    ]);
    expect(hiddenComplete.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-2",
      "item-3",
      "item-4",
    ]);
  });

  it("prepends older rows and dedupes by source identity", () => {
    const recent = [row(2), row(3)];
    const projection = {
      ...v2Projection,
      turnItems: recent.map((entry) => entry.item),
      visibleTurnItems: recent.map((entry, position) => ({ ...entry, position })),
    };
    const older = [row(0), row(1), row(2)];
    const merged = mergeOlderHistoryIntoProjection(projection, older);
    expect(merged.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(merged.visibleTurnItems.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
    expect(merged.turnItems.map((item) => item.id)).toEqual([
      "item-2",
      "item-3",
      "item-0",
      "item-1",
    ]);
  });

  it("fills inherited activity without confusing identical item IDs from different source threads", () => {
    const inherited = (index: number) => ({
      ...row(index),
      visibility: "inherited" as const,
      sourceThreadId: "fork-source" as never,
    });
    const local = row(1);
    const preview = { ...inherited(1), item: { ...row(1).item, title: "newer inherited title" } };
    const projection = {
      ...v2Projection,
      turnItems: [local.item],
      visibleTurnItems: [preview, local],
    };
    const merged = mergeOlderHistoryIntoProjection(projection, [inherited(0), inherited(1)]);
    expect(
      merged.visibleTurnItems.map((entry) => [entry.sourceThreadId, entry.sourceItemId]),
    ).toEqual([
      ["fork-source", "item-0"],
      ["fork-source", "item-1"],
      [v2ThreadId, "item-1"],
    ]);
    expect(merged.visibleTurnItems[1]?.item).toBe(preview.item);
    expect(merged.turnItems).toEqual([local.item]);
    expect(mergeOlderHistoryIntoProjection(merged, [inherited(0), inherited(1)])).toBe(merged);
  });

  it("retains live rows that arrived after the older page was fetched", () => {
    const live = [row(5), row(6)];
    const projection = {
      ...v2Projection,
      turnItems: live.map((entry) => entry.item),
      visibleTurnItems: live.map((entry, position) => ({ ...entry, position })),
    };
    const older = [row(3), row(4)];
    const merged = mergeOlderHistoryIntoProjection(projection, older);
    expect(merged.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-3",
      "item-4",
      "item-5",
      "item-6",
    ]);
  });

  it.each(["user_input_request", "approval_request"] as const)(
    "reveals retained %s bodies once and preserves current values",
    (type) => {
      const { question, approval, requests } = pendingDecisionFixture();
      const recent = { ...row(3), position: 0 };
      const cold = {
        ...v2Projection,
        turnItems: [recent.item, question, approval],
        visibleTurnItems: [recent],
        runtimeRequests: requests,
      };
      const pending = derivePendingThreadRequests(cold);
      expect(pending.userInputs).toHaveLength(1);
      expect(pending.approvals).toHaveLength(1);
      expect(pending.userInputs[0]?.questions).toEqual(question.questions);
      expect(pending.approvals[0]?.options).toEqual(approval.options);
      expect(pending.approvals[0]?.detail).toBe("Run the requested command?");
      expect(pending.approvals[0]?.appName).toBe("D10 fixture");
      const questionRow = { ...row(0), item: question, sourceItemId: question.id };
      const approvalRow = { ...row(1), item: approval, sourceItemId: approval.id };
      const page = [questionRow, questionRow, approvalRow];
      const merged = mergeOlderHistoryIntoProjection(cold, page);
      expect(merged.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
        "d10-question-item",
        "d10-approval-item",
        "item-3",
      ]);
      expect(new Set(merged.turnItems.map((item) => item.id)).size).toBe(3);
      expect(merged.turnItems.filter((item) => item.id === question.id)).toHaveLength(1);
      expect(merged.turnItems.filter((item) => item.id === approval.id)).toHaveLength(1);
      expect(mergeOlderHistoryIntoProjection(merged, page)).toBe(merged);

      const current =
        type === "user_input_request"
          ? {
              ...question,
              questions: [{ ...question.questions[0]!, question: "Current question" }],
            }
          : {
              ...approval,
              options: [
                { ...approval.options[0]!, warning: "Current warning" },
                approval.options[1]!,
              ],
            };
      const live = {
        ...cold,
        turnItems: cold.turnItems.map((item) => (item.id === current.id ? current : item)),
      };
      const staleMerged = mergeOlderHistoryIntoProjection(live, page);
      expect(
        staleMerged.visibleTurnItems.find((entry) => entry.sourceItemId === current.id)?.item,
      ).toBe(current);
      const presented = derivePendingThreadRequests(staleMerged);
      if (current.type === "user_input_request") {
        expect(presented.userInputs[0]?.questions).toEqual(current.questions);
      } else {
        expect(presented.approvals[0]?.options).toEqual(current.options);
      }
      expect(mergeOlderHistoryIntoProjection(staleMerged, page)).toBe(staleMerged);

      const runId = RunId.make("d10-rolled-back");
      const rolledBackRun = {
        id: runId,
        threadId: v2ThreadId,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("d10-message"),
        rootNodeId: NodeId.make("d10-node"),
        activeAttemptId: null,
        status: "rolled_back",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        checkpointId: null,
        contextHandoffId: null,
      } satisfies OrchestrationV2Run;
      const hidden = {
        ...live,
        runs: [rolledBackRun],
        turnItems: live.turnItems.map((item) =>
          item.id === current.id ? { ...item, runId } : item,
        ),
      };
      const hiddenMerged = mergeOlderHistoryIntoProjection(hidden, page);
      expect(hiddenMerged.visibleTurnItems.some((entry) => entry.sourceItemId === current.id)).toBe(
        false,
      );
      const resolved = {
        ...cold,
        runtimeRequests: requests.map((request) => ({
          ...request,
          status: "resolved" as const,
          resolvedAt: NOW,
        })),
      };
      expect(derivePendingThreadRequests(mergeOlderHistoryIntoProjection(resolved, page))).toEqual({
        approvals: [],
        userInputs: [],
      });
    },
  );

  it("does not resurrect a local item hidden while an older page was in flight", () => {
    const stalePageRow = row(1);
    const currentItem = {
      ...stalePageRow.item,
      output: "newer live output",
      updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
    };
    const projection = {
      ...v2Projection,
      turnItems: [currentItem],
      visibleTurnItems: [],
    };

    const merged = mergeOlderHistoryIntoProjection(projection, [stalePageRow]);

    expect(merged).toBe(projection);
    expect(merged.turnItems).toEqual([currentItem]);
    expect(merged.visibleTurnItems).toEqual([]);
  });

  it("retains merged older rows when a live turn-item update arrives", () => {
    const recent = [row(2), row(3)];
    const projection = {
      ...v2Projection,
      turnItems: recent.map((entry) => entry.item),
      visibleTurnItems: recent.map((entry, position) => ({ ...entry, position })),
    };
    const merged = mergeOlderHistoryIntoProjection(projection, [row(0), row(1)]);
    const liveItem = {
      ...row(3).item,
      output: "streamed",
    };
    const next = applyOrchestrationV2ProjectionEvent(merged, {
      id: "event-live-item" as never,
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: NOW,
      payload: liveItem,
    } as never);
    expect(next?.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(next?.visibleTurnItems[3]?.item).toEqual(liveItem);
  });

  it("keeps a history-page interrupt result visible when its request was retained at cold open", () => {
    const runId = "run-interrupt-cold" as never;
    const nodeId = "node-interrupt-cold" as never;
    const recent = row(5);
    const requestItem = {
      id: "item-interrupt-request" as never,
      type: "run_interrupt_request" as const,
      threadId: v2ThreadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      message: "Stopping",
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    const resultItem = {
      id: "item-interrupt-result" as never,
      type: "run_interrupt_result" as const,
      threadId: v2ThreadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed" as const,
      title: null,
      message: "Stopped",
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    const resultRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: v2ThreadId,
      sourceItemId: resultItem.id,
      item: resultItem,
    };
    const coldOpen = {
      ...v2Projection,
      runs: [
        {
          id: runId,
          threadId: v2ThreadId,
          ordinal: 1,
          providerInstanceId: "codex" as never,
          modelSelection: { instanceId: "codex" as never, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: "message-1" as never,
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      attempts: [
        {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial" as const,
          status: "running" as const,
          startedAt: NOW,
          completedAt: null,
        },
      ],
      turnItems: [requestItem, recent.item],
      visibleTurnItems: [{ ...recent, position: 0 }],
    };

    const requestMerged = mergeOlderHistoryIntoProjection(coldOpen, [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: v2ThreadId,
        sourceItemId: requestItem.id,
        item: requestItem,
      },
    ]);
    expect(requestMerged.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-request",
      "item-5",
    ]);

    const rolledBackRequestMerged = mergeOlderHistoryIntoProjection(
      {
        ...coldOpen,
        runs: coldOpen.runs.map((run) => ({
          ...run,
          status: "rolled_back" as const,
          completedAt: NOW,
        })),
      },
      [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2ThreadId,
          sourceItemId: requestItem.id,
          item: requestItem,
        },
      ],
    );
    expect(
      rolledBackRequestMerged.visibleTurnItems.map((entry) => String(entry.sourceItemId)),
    ).toEqual(["item-5"]);

    const merged = mergeOlderHistoryIntoProjection(coldOpen, [resultRow]);
    expect(merged.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-result",
      "item-5",
    ]);
    expect(merged.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(true);
    expect(merged.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(true);

    const attemptSuperseded = applyOrchestrationV2ProjectionEvent(
      merged,
      {
        id: "event-attempt-superseded" as never,
        type: "run-attempt.updated",
        threadId: v2ThreadId,
        runId,
        occurredAt: NOW,
        payload: {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial",
          status: "superseded",
          startedAt: NOW,
          completedAt: NOW,
        },
      } as never,
      { partialTimeline: true },
    );

    expect(attemptSuperseded?.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-result",
      "item-5",
    ]);

    const withoutRequest = {
      ...merged,
      turnItems: merged.turnItems.filter((item) => item.type !== "run_interrupt_request"),
    };
    const hidden = applyOrchestrationV2ProjectionEvent(
      withoutRequest,
      {
        id: "event-attempt-superseded-missing" as never,
        type: "run-attempt.updated",
        threadId: v2ThreadId,
        runId,
        occurredAt: NOW,
        payload: {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial",
          status: "superseded",
          startedAt: NOW,
          completedAt: NOW,
        },
      } as never,
      { partialTimeline: true },
    );
    expect(hidden?.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual(["item-5"]);
  });
});
