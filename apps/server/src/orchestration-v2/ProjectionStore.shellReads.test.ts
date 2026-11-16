import { assert, it } from "@effect/vitest";
import {
  EventId,
  ContextTransferId,
  MessageId,
  type OrchestrationV2AppThread,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { latestUnheldRun } from "@goat/shared/orchestrationV2ThreadError";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
  d10DecisionFixture,
  saveD10Request,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

it.effect("record reads restrict provider histories to delivery identities", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("delivery-identities");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (const suffix of ["selected", "history"]) {
      const id = ProviderThreadId.make(`provider-thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:delivery-identities:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "active",
          firstRunOrdinal: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    for (const [suffix, attempt] of [
      ["selected", "current"],
      ["history", "old"],
      ["runless", null],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:delivery-turn:${suffix}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${suffix}`),
          providerThreadId: ProviderThreadId.make("provider-thread:selected"),
          nodeId: NodeId.make("node:delivery"),
          runAttemptId: attempt === null ? null : RunAttemptId.make(attempt),
          nativeTurnRef: null,
          ordinal: suffix === "selected" ? 1 : suffix === "history" ? 2 : 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [RunAttemptId.make("current")],
      })).providerTurns.map((turn) => turn.id),
      ["turn:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [],
      })).providerTurns,
      [],
    );
    const selected = yield* store.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
    });
    assert.deepEqual(
      selected.providerThreads.map((row) => row.id),
      ["provider-thread:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [],
      })).providerThreads,
      [],
    );
    const ownerNodeId = NodeId.make("node:delivery-identities:owner");
    yield* store.apply({
      id: EventId.make("event:delivery-identities:owner-node"),
      type: "node.updated",
      threadId,
      runId: RunId.make("run:delivery-identities:rolled-back"),
      nodeId: ownerNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: ownerNodeId,
        threadId,
        runId: RunId.make("run:delivery-identities:rolled-back"),
        rootNodeId: NodeId.make("node:delivery-identities:rolled-back"),
        parentNodeId: NodeId.make("node:delivery-identities:rolled-back"),
        kind: "subagent",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: now,
      },
    });
    yield* store.apply({
      id: EventId.make("event:delivery-identities:owned"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:owned"),
        appThreadId: ThreadId.make("thread:delivery-identities:child"),
        driver,
        providerInstanceId,
        providerSessionId: null,
        ownerNodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        status: "idle",
        firstRunOrdinal: 2,
        createdAt: now,
        updatedAt: now,
      },
    });
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"])).providerThreads.map(
        (row) => row.id,
      ),
      ["provider-thread:history", "provider-thread:selected", "provider-thread:owned"],
    );
    // Unselected history must not be decoded, even if its payload is unreadable.
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
      WHERE provider_thread_id = 'provider-thread:history'`;
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
      })).providerThreads,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s idle compaction filters keep the latest run, live work and the newest usage",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("idle-compaction");
      const now = yield* DateTime.now;
      const minutes = (count: number) => DateTime.add(now, { minutes: count });
      const selected = ProviderThreadId.make("provider-thread:idle-selected");
      const nodeId = NodeId.make("node:idle-compaction");
      for (const [ordinal, status] of [
        [2, "completed"],
        [3, "completed"],
        [4, "failed"],
        [5, "cancelled"],
      ] as const) {
        const runId = RunId.make(`run:idle-compaction:${ordinal}`);
        yield* store.apply({
          id: EventId.make(`event:idle-compaction:run-${ordinal}`),
          type: "run.created",
          threadId,
          runId,
          nodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: selected,
            userMessageId: MessageId.make(`message:idle-compaction:${ordinal}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status,
            requestedAt: now,
            startedAt: status === "cancelled" ? null : now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      }
      for (const [id, providerThreadId, ordinal, usageAt] of [
        ["turn:idle-old", selected, 1, minutes(1)],
        ["turn:idle-newest", selected, 2, minutes(3)],
        ["turn:idle-later-ordinal", selected, 3, minutes(2)],
        ["turn:idle-no-usage", selected, 4, null],
        [
          "turn:idle-other-thread",
          ProviderThreadId.make("provider-thread:idle-other"),
          1,
          minutes(9),
        ],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:${id}`),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make(id),
            providerThreadId,
            nodeId,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal,
            status: "completed",
            startedAt: now,
            completedAt: now,
            ...(usageAt === null
              ? {}
              : { tokenUsage: { usedTokens: 150_000, updatedAt: DateTime.formatIso(usageAt) } }),
          },
        });
      }
      for (const status of ["pending", "resolved"] as const) {
        yield* store.apply({
          id: EventId.make(`event:idle-compaction:request-${status}`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:idle-compaction:${status}`),
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status,
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: status === "pending" ? null : now,
          },
        });
      }
      for (const status of ["pending", "consumed"] as const) {
        yield* store.apply({
          id: EventId.make(`event:idle-compaction:transfer-${status}`),
          type: "context-transfer.created",
          threadId,
          occurredAt: now,
          payload: {
            id: ContextTransferId.make(`transfer:idle-compaction:${status}`),
            type: "merge_back",
            sourceThreadId: ThreadId.make("thread:idle-compaction:side"),
            targetThreadId: threadId,
            sourcePoint: { threadId: ThreadId.make("thread:idle-compaction:side") },
            basePoint: null,
            sourceProviderInstanceId: providerInstanceId,
            targetProviderInstanceId: providerInstanceId,
            targetRunId: null,
            status,
            resolution: null,
            createdBy: "user",
            error: null,
            createdAt: now,
            updatedAt: now,
            consumedAt: status === "pending" ? null : now,
          },
        });
      }

      const records = yield* store.getThreadRecords(
        threadId,
        ["runs", "providerTurns", "runtimeRequests", "contextTransfers"],
        {
          runStatuses: ["preparing", "starting", "running", "rolled_back"],
          includeLatestRun: true,
          providerTurnThreadIds: [selected],
          latestProviderTurnUsageOnly: true,
          runtimeRequestStatuses: ["pending"],
          contextTransferStatuses: ["pending"],
        },
      );
      // The failed latest run stays, so a completed earlier run is not mistaken for the latest.
      assert.deepEqual(
        records.runs.map((run) => run.id),
        ["run:idle-compaction:rolled-back", "run:idle-compaction:4"],
      );
      assert.deepEqual(
        records.providerTurns.map((turn) => turn.id),
        ["turn:idle-newest"],
      );
      assert.deepEqual(
        records.runtimeRequests.map((request) => request.id),
        ["request:idle-compaction:pending"],
      );
      assert.deepEqual(
        records.contextTransfers.map((transfer) => transfer.id),
        ["transfer:idle-compaction:pending"],
      );
      const empty = yield* store.getThreadRecords(threadId, ["runs", "providerTurns"], {
        runStatuses: [],
        providerTurnThreadIds: [],
        latestProviderTurnUsageOnly: true,
      });
      assert.deepEqual([empty.runs, empty.providerTurns], [[], []]);
    }).pipe(Effect.provide(layer)),
);

it.effect("shells flag a latest run triggered by a provider background wake", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("background-wake");
    const initial = yield* store.getThreadProjection(threadId);
    const at = initial.updatedAt;
    let ordinal = 1;
    for (const [id, source, outcome, expected] of [
      ["background-task", { kind: "background_task" }, "updated", true],
      ["monitor", { kind: "monitor" }, "updated", true],
      ["command", { kind: "command" }, "updated", true],
      ["command-finished", { kind: "command" }, "completed", false],
      ["monitor-stopped", { kind: "monitor" }, "cancelled", false],
      ["subagent", { kind: "subagent" }, "updated", false],
      ["delegated", { kind: "delegated_task", taskIds: [] }, "updated", false],
      ["steered", { kind: "background_task" }, "updated", false],
    ] as const) {
      const messageId = MessageId.make(`message:background-wake:${id}`);
      yield* store.apply({
        id: EventId.make(`event:background-wake:${id}:message`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          createdBy: "agent",
          creationSource: "server",
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
          notification: { source, outcome, summary: "Background activity updated" },
          ...(id === "delegated"
            ? {
                delegatedCompletion: {
                  parentRunId: initial.runs[0]!.id,
                  generation: 1,
                  taskIds: [],
                },
              }
            : {}),
        },
      });
      ordinal += 1;
      yield* store.apply({
        id: EventId.make(`event:background-wake:${id}:run`),
        type: "run.created",
        threadId,
        occurredAt: at,
        payload: {
          ...initial.runs[0]!,
          id: RunId.make(`run:background-wake:${id}`),
          ordinal,
          userMessageId: messageId,
          status: "completed",
          completedAt: at,
        },
      });
      if (id === "steered") {
        yield* store.apply({
          id: EventId.make("event:background-wake:steered:follow-up"),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            id: MessageId.make("message:background-wake:steered:follow-up"),
            threadId,
            runId: RunId.make("run:background-wake:steered"),
            nodeId: null,
            createdBy: "user",
            creationSource: "web",
            role: "user",
            text: "also fix X",
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        });
      }
      const shells = [
        yield* store.getThreadShell(threadId),
        ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
      ];
      // Shells leave the flag out unless it is set, as they do for a held start.
      const flags = shells.map((shell) =>
        shell && "latestRunBackgroundWake" in shell ? shell.latestRunBackgroundWake : "omitted",
      );
      assert.deepEqual(flags, expected ? [true, true] : ["omitted", "omitted"], id);
      const awareness = yield* store.getAgentAwarenessSnapshot(threadId);
      assert.equal(awareness.threads[0]?.latestRunBackgroundWake, expected || undefined);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s queue readiness skips held runs without bypassing active work", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("held-queue");
    const { runs } = yield* store.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const held = { ...run, status: "queued" as const, queueHeld: true };
    yield* store.apply({
      id: EventId.make("held-queue:held"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: held,
    });
    assert.isFalse(yield* store.canStartQueuedRun(threadId));

    const wake = { ...run, id: RunId.make("held-queue:wake"), ordinal: 2 };
    for (const status of ["running", "queued", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`held-queue:wake:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...wake, status },
      });
      assert.equal(yield* store.canStartQueuedRun(threadId), status === "queued");
    }
    assert.deepEqual((yield* store.getThreadProjection(threadId)).runs[0], held);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s fallback candidates preserve trigger and recovery policy", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    const ids: Record<string, ThreadId> = {};
    for (const failure of [
      "usage_limit",
      "provider_error",
      "transport_error",
      "unknown",
      "permission_error",
    ] as const) {
      const threadId = yield* addRolledBackRecoveryCandidate(`fallback-${failure}`);
      ids[failure] = threadId;
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      yield* store.apply({
        id: EventId.make(`fallback:${failure}:failed`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...original, status: "failed", completedAt: now },
      });
      yield* store.apply({
        id: EventId.make(`fallback:${failure}:error`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`fallback:${failure}:error`),
          threadId,
          runId: original.id,
          nodeId: original.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: {
            class: failure,
            message: "Failed",
            code: null,
            retryable: null,
            ...(failure === "usage_limit" ? { resetAt } : {}),
          },
        },
      });
    }
    const options = { now, autoResume: false, snooze: false };
    const selected = Effect.fn("selected")(function* (
      input: Parameters<typeof store.getLimitRecoveryCandidates>[0],
    ) {
      return (yield* store.getLimitRecoveryCandidates(input)).map((row) => row.id).toSorted();
    });
    assert.deepEqual(yield* selected(options), []);
    assert.deepEqual(yield* selected({ ...options, autoResume: true }), [ids.usage_limit]);
    assert.deepEqual(yield* selected({ ...options, fallbackClasses: ["provider_error"] }), [
      ids.provider_error,
    ]);
    assert.deepEqual(yield* selected({ ...options, fallbackClasses: ["transport_error"] }), [
      ids.transport_error,
    ]);
    const fallbackOptions = {
      ...options,
      fallbackClasses: ["usage_limit", "provider_error", "transport_error"] as const,
    };
    assert.deepEqual(
      yield* selected(fallbackOptions),
      [ids.provider_error, ids.transport_error, ids.usage_limit].toSorted(),
    );
    for (const failure of ["provider_error", "transport_error"] as const) {
      const threadId = ids[failure]!;
      const executed = (yield* store.getThreadProjection(threadId)).runs[0]!;
      yield* store.apply({
        id: EventId.make(`fallback:${failure}:cancelled`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          ...executed,
          id: RunId.make(`fallback:${failure}:cancelled`),
          ordinal: executed.ordinal + 1,
          status: "cancelled",
          startedAt: null,
          completedAt: DateTime.add(now, { seconds: 1 }),
        },
      });
      assert.equal((yield* store.getThreadShell(threadId))!.status, "cancelled");
      const candidate = (yield* store.getLimitRecoveryCandidates(fallbackOptions)).find(
        (row) => row.id === threadId,
      );
      assert.isDefined(candidate);
      assert.equal(candidate!.latestRunId, executed.id);
      assert.equal(candidate!.lastErrorClass, failure);
      assert.equal(candidate!.status, "failed");
    }
    const threadId = ids.usage_limit!;
    const projection = yield* store.getThreadProjection(threadId);
    const recovery = { runId: projection.runs[0]!.id, resetAt, autoResume: true, snooze: false };
    const update = Effect.fn("updateRecoveryFixture")(function* (
      patch: Partial<OrchestrationV2AppThread>,
    ) {
      yield* store.apply({
        id: EventId.make("fallback:metadata"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: { ...projection.thread, limitRecovery: recovery, ...patch },
      });
    });
    yield* update({});
    assert.deepEqual(yield* selected({ ...options, autoResume: true }), []);
    assert.include(yield* selected(fallbackOptions), threadId);
    assert.deepEqual(yield* selected({ ...options, now: DateTime.makeUnsafe(resetAt) }), [
      threadId,
    ]);
    for (const patch of [
      { snoozedUntil: DateTime.add(now, { minutes: 30 }) },
      { archivedAt: now },
      { deletedAt: now },
      { settledOverride: "settled" as const },
    ]) {
      yield* update(patch);
      assert.notInclude(yield* selected(fallbackOptions), threadId);
    }
    yield* update({});
    const due = (yield* store.getLimitRecoveryCandidates(fallbackOptions)).find(
      (row) => row.id === threadId,
    )!;
    assert.deepEqual(due.limitRecovery, recovery);
    assert.equal(due.usageLimitResetAt, resetAt);
    yield* update({ limitRecovery: { ...recovery, autoResume: false, snooze: false } });
    assert.notInclude(yield* selected(fallbackOptions), threadId);
    yield* update({ limitRecovery: { ...recovery, autoResume: false, snooze: true } });
    assert.include(yield* selected(fallbackOptions), threadId);
    const request = d10DecisionFixture(threadId, "fallback-pending").requests[0]!;
    yield* saveD10Request(threadId, request);
    assert.notInclude(yield* selected(fallbackOptions), threadId);
    yield* saveD10Request(threadId, { ...request, status: "resolved", resolvedAt: now });
    assert.include(yield* selected(fallbackOptions), threadId);
    yield* store.apply({
      id: EventId.make("fallback-stop"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("fallback-stop"),
        threadId,
        runId: recovery.runId,
        nodeId: projection.runs[0]!.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 3,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stopped",
      },
    });
    assert.notInclude(yield* selected(fallbackOptions), threadId);
    yield* update({ limitRecovery: recovery });
    assert.include(yield* selected({ ...options, now: DateTime.makeUnsafe(resetAt) }), threadId);
    assert.include(
      yield* selected({ ...fallbackOptions, now: DateTime.makeUnsafe(resetAt) }),
      threadId,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s shells use the latest subagent owner for duplicate provider-thread ids",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("duplicate-provider-thread-owner");
      const initial = yield* store.getThreadProjection(threadId);
      const at = initial.updatedAt;
      const otherThreadId = yield* addRolledBackRecoveryCandidate(
        "duplicate-provider-thread-owner:other",
      );
      const other = yield* store.getThreadProjection(otherThreadId);
      const otherRun = other.runs[0]!;
      const otherInstanceId = ProviderInstanceId.make("codex-other");
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-completed"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "completed", completedAt: at },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-switched"),
        type: "thread.provider-switched",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...other.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      const providerThreadId = ProviderThreadId.make("provider-thread:duplicate-owner");
      const nativeTaskId = "native-task:duplicate-provider-thread-owner";
      for (const [appThreadId, owner] of [
        [otherThreadId, otherInstanceId],
        [threadId, providerInstanceId],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:duplicate-provider-thread-owner:${owner}`),
          type: "provider-thread.updated",
          threadId: appThreadId,
          occurredAt: at,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: owner,
            providerSessionId: null,
            appThreadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
            pendingBackgroundTasks:
              owner === otherInstanceId
                ? [{ taskId: nativeTaskId, kind: "subagent", description: "Review" }]
                : [],
          },
        });
      }
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:completed"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
      });
      const item = {
        ...initial.turnItems[0]!,
        id: TurnItemId.make("item:duplicate-provider-thread-owner"),
        providerThreadId,
        nativeItemRef: { driver, nativeId: nativeTaskId, strength: "strong" as const },
        type: "subagent" as const,
        status: "running" as const,
        subagentId: NodeId.make("node:duplicate-provider-thread-owner"),
        origin: "provider_native" as const,
        driver,
        providerInstanceId,
        childThreadId: null,
        title: "Review",
        prompt: "Review",
        result: null,
      };
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-item"),
        type: "turn-item.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...item,
          id: TurnItemId.make("item:duplicate-provider-thread-owner:other"),
          threadId: otherThreadId,
          runId: otherRun.id,
          nodeId: otherRun.rootNodeId,
          subagentId: NodeId.make("node:duplicate-provider-thread-owner:other"),
        },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:switched"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: at,
        payload: {
          ...initial.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      assert.deepEqual((yield* store.getThreadProjection(otherThreadId)).providerThreads, []);
      const assertOwners = Effect.fnUntraced(function* (
        targetThreadId: ThreadId,
        expected: ReadonlyArray<unknown>,
        natives: ReadonlyArray<unknown>,
      ) {
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === targetThreadId,
        );
        for (const shell of [yield* store.getThreadShell(targetThreadId), listed]) {
          assert.equal(shell?.providerInstanceId, otherInstanceId);
          assert.equal(shell?.activeRunId, null);
          assert.deepEqual(
            shell?.pendingBackgroundTasks?.filter((task) => task.kind === "subagent"),
            expected,
          );
          assert.deepEqual(shell?.nativeSubagents, natives);
        }
      });
      const owned = [
        { taskId: nativeTaskId, description: item.title, kind: "subagent", providerInstanceId },
      ];
      const nativeOf = (subagentId: NodeId) => [
        { id: subagentId, childThreadId: null, title: "Review", status: "running" },
      ];
      yield* assertOwners(threadId, owned, nativeOf(item.subagentId));
      yield* assertOwners(
        otherThreadId,
        owned,
        nativeOf(NodeId.make("node:duplicate-provider-thread-owner:other")),
      );
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:stopped"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: { ...item, status: "cancelled", completedAt: at },
      });
      yield* assertOwners(threadId, [], []);
      const ownerSnapshot = (yield* store.getThreadProjection(threadId)).providerThreads[0]!;
      // Rollback writes its provider snapshot before the rolled-back run events.
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:rollback-provider-thread"),
        type: "provider-thread.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: ownerSnapshot,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-rolled-back"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "rolled_back", completedAt: at },
      });
      const rolledBack = yield* store.getThreadProjection(otherThreadId);
      assert.deepEqual(rolledBack.providerThreads, []);
      assert.equal(
        (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
        providerThreadId,
      );
      assert.deepEqual(
        ProjectionStore.threadShellFromProjection(rolledBack).pendingBackgroundTasks,
        [],
      );
      assert.deepEqual(ProjectionStore.threadShellFromProjection(rolledBack).nativeSubagents, []);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s newest run read names the newest run by ordinal and the thread's archived and deleted state",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      assert.isNull(yield* store.getThreadNewestRun(ThreadId.make("thread:newest-run:unknown")));
      const threadId = yield* addRolledBackRecoveryCandidate("newest-run");
      const earlier = (yield* store.getThreadProjection(threadId)).runs[0]!;
      yield* store.apply({
        id: EventId.make("newest-run:running"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...earlier, status: "running", completedAt: null },
      });
      const removed = RunId.make("newest-run:removed");
      yield* store.apply({
        id: EventId.make("newest-run:removed"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          ...earlier,
          id: removed,
          ordinal: 2,
          userMessageId: MessageId.make("newest-run:removed"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      // The shell presents the run still going; the newest run is the one removed before it started.
      assert.equal((yield* store.getThreadShell(threadId))?.latestRunId, earlier.id);
      assert.deepEqual(yield* store.getThreadNewestRun(threadId), {
        archivedAt: null,
        deletedAt: null,
        newestRun: { id: removed, ordinal: 2 },
      });
      const thread = yield* store.getThread(threadId);
      for (const [type, overrides] of [
        ["thread.archived", { archivedAt: now }],
        ["thread.deleted", { archivedAt: null, deletedAt: now }],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`newest-run:${type}`),
          type,
          threadId,
          occurredAt: now,
          payload: { ...thread, ...overrides, updatedAt: now },
        });
        const read = yield* store.getThreadNewestRun(threadId);
        assert.deepEqual(read, {
          archivedAt: overrides.archivedAt,
          deletedAt: "deletedAt" in overrides ? overrides.deletedAt : null,
          newestRun: { id: removed, ordinal: 2 },
        });
      }
    }).pipe(Effect.provide(layer)),
);
it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s shell presents a run still going past two later runs cancelled before they started, as latestUnheldRun does",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* addRolledBackRecoveryCandidate("outlived-twice");
      const earlier = (yield* store.getThreadProjection(threadId)).runs[0]!;
      yield* store.apply({
        id: EventId.make("outlived-twice:running"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...earlier, status: "running", completedAt: null },
      });
      // The first queued message is removed, then the second is steered a second later: the
      // nearer earlier run ended before the later cancellation, the run still going did not.
      for (const [ordinal, cancelledAt] of [
        [2, now],
        [3, DateTime.add(now, { seconds: 1 })],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`outlived-twice:${ordinal}`),
          type: "run.created",
          threadId,
          occurredAt: cancelledAt,
          payload: {
            ...earlier,
            id: RunId.make(`outlived-twice:${ordinal}`),
            ordinal,
            userMessageId: MessageId.make(`outlived-twice:${ordinal}`),
            status: "cancelled",
            startedAt: null,
            completedAt: cancelledAt,
          },
        });
      }
      assert.equal(
        latestUnheldRun((yield* store.getThreadProjection(threadId)).runs)?.id,
        earlier.id,
      );
      assert.equal((yield* store.getThreadShell(threadId))?.latestRunId, earlier.id);
    }).pipe(Effect.provide(layer)),
);
