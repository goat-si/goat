import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  addRolledBackRecoveryCandidate,
  driver,
  layerTest,
  modelSelection,
  providerInstanceId,
} from "./ProjectionStore.testkit.ts";

// Carried from upstream's ProjectionStore.test.ts (591188471a), which is at its code budget here.
// One thread holds every way a run can still matter after a compaction. A run is requested at
// its ordinal in minutes and ends 30 seconds later, unless the table says otherwise.
it.effect("a compacted thread reads every run, and run records only for its recent runs", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("compacted");
    const created = yield* DateTime.now;
    const at = (minutes: number) => DateTime.add(created, { minutes });
    const runId = (ordinal: number) => RunId.make(`run:compacted:${ordinal}`);
    const rootNodeId = (ordinal: number) => NodeId.make(`node:compacted:${ordinal}`);
    const attemptId = (ordinal: number) => RunAttemptId.make(`attempt:compacted:${ordinal}`);
    const providerThreadId = ProviderThreadId.make("provider-thread:compacted");
    const messageId = (ordinal: number) => MessageId.make(`message:compacted:${ordinal}`);
    const item = (
      ordinal: number,
      itemOrdinal: number,
      status: "completed" | "failed" | "running",
    ) => ({
      threadId,
      runId: runId(ordinal),
      nodeId: rootNodeId(ordinal),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: itemOrdinal,
      status,
      title: null,
      startedAt: at(ordinal),
      completedAt: status === "running" ? null : at(ordinal),
      updatedAt: at(ordinal),
    });
    const compaction = (ordinal: number, status: "completed" | "failed" | "running") =>
      store.apply({
        id: EventId.make(`event:compacted:compaction-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: rootNodeId(ordinal),
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...item(ordinal, ordinal * 10 + 1, status),
          id: TurnItemId.make(`item:compacted:compaction-${ordinal}`),
          type: "compaction",
          driver,
        },
      });
    for (const [ordinal, status, endedAt] of [
      [2, "queued", null],
      [3, "completed"],
      // A held queue ran this old run after the compactions.
      [4, "completed", at(11.5)],
      [5, "completed"],
      [6, "completed"],
      [7, "completed"],
      [8, "completed"],
      [9, "completed"],
      [10, "completed"],
      [11, "completed"],
      [12, "completed"],
      [13, "rolled_back"],
      [14, "completed"],
      [15, "running", null],
    ] as const) {
      const text = `Prompt ${ordinal}`;
      const authored = { createdBy: "user", creationSource: "web" } as const;
      const nodeId = rootNodeId(ordinal);
      const ended = endedAt === undefined ? at(ordinal + 0.5) : endedAt;
      yield* store.apply({
        id: EventId.make(`event:compacted:run-${ordinal}`),
        type: "run.created",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        providerInstanceId,
        occurredAt: at(ordinal),
        payload: {
          id: runId(ordinal),
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: messageId(ordinal),
          rootNodeId: nodeId,
          activeAttemptId: attemptId(ordinal),
          status,
          requestedAt: at(ordinal),
          startedAt: status === "queued" ? null : at(ordinal),
          completedAt: ended,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:attempt-${ordinal}`),
        type: "run-attempt.created",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: attemptId(ordinal),
          runId: runId(ordinal),
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status: ended === null ? "running" : "completed",
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:node-${ordinal}`),
        type: "node.updated",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: nodeId,
          threadId,
          runId: runId(ordinal),
          rootNodeId: nodeId,
          parentNodeId: null,
          kind: "root_turn",
          status: ended === null ? "running" : "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:turn-${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: ProviderTurnId.make(`turn:compacted:${ordinal}`),
          providerThreadId,
          nodeId,
          runAttemptId: attemptId(ordinal),
          nativeTurnRef: null,
          ordinal,
          status: ended === null ? "running" : "completed",
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:message-${ordinal}`),
        type: "message.updated",
        threadId,
        runId: runId(ordinal),
        occurredAt: at(ordinal),
        payload: {
          ...authored,
          id: messageId(ordinal),
          threadId,
          runId: runId(ordinal),
          nodeId,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: at(ordinal),
          updatedAt: at(ordinal),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:prompt-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...authored,
          ...item(ordinal, ordinal * 10, status === "queued" ? "running" : "completed"),
          ...(status === "queued" ? { status: "pending" as const } : {}),
          id: TurnItemId.make(`item:compacted:prompt-${ordinal}`),
          type: "user_message",
          messageId: messageId(ordinal),
          inputIntent: status === "queued" ? "queued_turn" : "turn_start",
          text,
          attachments: [],
        },
      });
    }
    // Each collection as the ordinals of the runs it was read for. Run 1 is the helper's.
    const ordinals = (ids: ReadonlyArray<string | null>) =>
      [...new Set(ids.map((id) => Number(id?.split(":").at(-1)) || 1))].toSorted((a, b) => a - b);
    const read = (keepRunIds: ReadonlyArray<RunId> = [], keepMessageId = messageId(0)) =>
      store
        .getThreadRecords(
          threadId,
          ["runs", "attempts", "nodes", "providerTurns", "messages", "turnItems"],
          {
            messageRoles: ["user"],
            omitSettledLeafNodes: true,
            sinceLastCompaction: { keepRunIds, keepMessageId },
          },
        )
        .pipe(
          Effect.map((records) => ({
            runs: records.runs.length,
            attempts: ordinals(records.attempts.map((attempt) => attempt.runId)),
            nodes: ordinals(records.nodes.map((node) => node.runId)),
            providerTurns: ordinals(records.providerTurns.map((turn) => turn.runAttemptId)),
            messages: ordinals(records.messages.map((message) => message.runId)),
            turnItems: ordinals(records.turnItems.map((row) => row.runId)),
          })),
        );
    const all = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    // Every run and every turn item is read, so a model switch is still measured from the last
    // prompt. Run 1, the helper's, holds only a command item.
    const expected = (recent: ReadonlyArray<number>) => ({
      runs: 15,
      attempts: recent,
      nodes: recent,
      providerTurns: recent,
      messages: recent,
      turnItems: [1, ...all],
    });

    // Nothing is compacted yet, so the whole history is current.
    assert.deepEqual(yield* read(), expected(all));

    // The window starts at the compaction's run. Queued run 2 and held run 4 are older but had
    // not ended by then.
    yield* compaction(7, "completed");
    assert.deepEqual(yield* read(), expected([2, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15]));

    // The latest compaction wins.
    yield* compaction(11, "completed");
    const latest = expected([2, 4, 11, 12, 13, 14, 15]);
    assert.deepEqual(yield* read(), latest);

    // A compaction that was rolled back, failed or is still running does not move the window.
    yield* compaction(13, "completed");
    yield* compaction(14, "failed");
    yield* compaction(15, "running");
    assert.deepEqual(yield* read(), latest);

    // A named run and the run that holds a re-sent message are read too.
    assert.deepEqual(
      yield* read([runId(3)], messageId(6)),
      expected([2, 3, 4, 6, 11, 12, 13, 14, 15]),
    );

    // A command also skips the node and the provider thread of each settled task. Tasks ended on
    // both sides of the compaction; one ran in the provider thread the thread's own runs use.
    const addProviderThread = (id: ProviderThreadId, appThreadId: ThreadId) =>
      store.apply({
        id: EventId.make(`event:compacted:${id}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: created,
        payload: {
          id,
          appThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "idle",
          firstRunOrdinal: null,
          createdAt: created,
          updatedAt: created,
        },
      });
    yield* addProviderThread(providerThreadId, threadId);
    for (const [name, ordinal, delivery] of [
      ["old-delivered", 5, "delivered"],
      ["old-pending", 5, "pending"],
      ["old-own-thread", 5, "delivered"],
      ["recent-delivered", 12, "delivered"],
      ["recent-pending", 12, "pending"],
    ] as const) {
      const id = NodeId.make(`node:compacted:task:${name}`);
      const taskProviderThreadId =
        name === "old-own-thread"
          ? providerThreadId
          : ProviderThreadId.make(`provider-thread:compacted:task:${name}`);
      if (taskProviderThreadId !== providerThreadId) {
        yield* addProviderThread(
          taskProviderThreadId,
          ThreadId.make(`thread:compacted:child:${name}`),
        );
      }
      const task = {
        id,
        threadId,
        runId: runId(ordinal),
        parentNodeId: rootNodeId(ordinal),
        status: "completed",
        startedAt: at(ordinal),
        completedAt: at(ordinal),
      } as const;
      yield* store.apply({
        id: EventId.make(`event:compacted:task:${name}`),
        type: "subagent.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: id,
        driver,
        providerInstanceId,
        occurredAt: at(ordinal),
        payload: {
          ...task,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: taskProviderThreadId,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Do the work",
          title: name,
          model: null,
          completionDelivery: { state: delivery, observedByRunId: null },
          result: null,
          updatedAt: at(ordinal),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:task-node:${name}`),
        type: "node.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: id,
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...task,
          rootNodeId: rootNodeId(ordinal),
          kind: "subagent",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
        },
      });
    }
    const names = (ids: ReadonlyArray<string>) => ids.map((id) => id.split(":").at(-1)).toSorted();
    const readWithTasks = (filter: ProjectionStore.ProjectionRecordFilter) =>
      store
        .getThreadRecords(
          threadId,
          [
            "runs",
            "attempts",
            "nodes",
            "providerThreads",
            "providerTurns",
            "messages",
            "turnItems",
          ],
          { messageRoles: ["user"], omitSettledLeafNodes: true, ...filter },
        )
        .pipe(
          Effect.map((records) => ({
            runs: names(records.runs.map((run) => run.id)),
            turnItems: names(records.turnItems.map((row) => row.id)),
            attempts: names(records.attempts.map((attempt) => attempt.id)),
            rootNodes: names(
              records.nodes.flatMap((node) => (node.kind === "root_turn" ? [node.id] : [])),
            ),
            taskNodes: names(
              records.nodes.flatMap((node) => (node.kind === "subagent" ? [node.id] : [])),
            ),
            providerThreads: names(records.providerThreads.map((thread) => thread.id)),
            providerTurns: names(records.providerTurns.map((turn) => turn.id)),
            messages: names(records.messages.map((message) => message.id)),
          })),
        );
    const window = {
      sinceLastCompaction: { keepRunIds: [runId(3)], keepMessageId: messageId(6) },
    };
    const windowed = yield* readWithTasks(window);
    const unsettled = yield* readWithTasks({ omitSettledSubagentRecords: true });
    const both = yield* readWithTasks({ ...window, omitSettledSubagentRecords: true });
    // Each filter alone keeps records the other one drops.
    assert.deepEqual(windowed.taskNodes, ["recent-delivered", "recent-pending"]);
    assert.lengthOf(windowed.providerThreads, 5);
    assert.deepEqual(unsettled.taskNodes, ["old-pending", "recent-pending"]);
    assert.deepEqual(unsettled.providerThreads, ["compacted", "old-pending", "recent-pending"]);
    assert.lengthOf(unsettled.rootNodes, all.length);
    assert.lengthOf(unsettled.runs, 15);
    // Together: every run, every turn item and the provider thread the runs use stay, and the
    // windowed records are read for the recent and named runs, less each settled task's node.
    const recentRuns = ["11", "12", "13", "14", "15", "2", "3", "4", "6"];
    assert.deepEqual(both, {
      ...unsettled,
      attempts: recentRuns,
      rootNodes: recentRuns,
      taskNodes: ["recent-pending"],
      providerTurns: recentRuns,
      messages: recentRuns,
    });
    const keptUnsettled = new Map(Object.entries(unsettled));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(windowed).map(([key, kept]) => [
          key,
          kept.filter((name) => keptUnsettled.get(key)?.includes(name)),
        ]),
      ),
      both,
    );
  }).pipe(Effect.provide(layerTest)),
);
