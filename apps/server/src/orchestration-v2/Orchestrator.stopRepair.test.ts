import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import { fakeCloudDriver, makeFakeCloudAdapter } from "./testkit/FakeCloudAdapter.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("Stop repairs local work without settling older cloud items or native rosters", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:mixed-background-repair");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-mixed-background-repair"),
      threadId,
      projectId: ProjectId.make("project:mixed-background-repair"),
      title: "Mixed history",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const ordinal of [1, 2]) {
      const cloud = ordinal === 1;
      const runId = RunId.make(`run:mixed:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:mixed:${ordinal}`);
      const nodeId = NodeId.make(`node:mixed:${ordinal}`);
      const providerThreadId = ProviderThreadId.make(`provider-thread:mixed:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:mixed:${ordinal}`);
      const status = cloud ? "completed" : "running";
      yield* projections.apply({
        id: EventId.make(`mixed:provider-thread:${ordinal}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: cloud ? fakeCloudDriver : adapter.driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: cloud ? "idle" : "active",
          firstRunOrdinal: ordinal,
          lastRunOrdinal: ordinal,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [{ taskId: `native-background:${ordinal}`, kind: "command" }],
          createdAt: now,
          updatedAt: now,
          ...(cloud
            ? {
                cloudTask: {
                  taskId: "remote-mixed-history",
                  status: "running" as const,
                  tracking: "link-only" as const,
                  url: "https://example.com/tasks/mixed",
                  source: {
                    repository: "https://github.com/acme/repo",
                    branch: "dev",
                    sha: "a".repeat(40),
                  },
                  localChangesExcluded: true,
                  updatedAt: DateTime.formatIso(now),
                },
              }
            : {}),
        },
      });
      yield* projections.apply({
        id: EventId.make(`mixed:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:mixed:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: cloud ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`mixed:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status,
          startedAt: now,
          completedAt: cloud ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`mixed:node:${ordinal}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status,
          countsForRun: true,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: cloud ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`mixed:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status,
          startedAt: now,
          completedAt: cloud ? now : null,
        },
      });
      // Cover both ownership paths: a run-owned item without a provider-thread
      // binding and a runless item bound only to the cloud provider thread.
      for (const runless of cloud ? [false, true] : [false]) {
        yield* projections.apply({
          id: EventId.make(`mixed:item:${ordinal}:${runless}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:mixed:${ordinal}:${runless}`),
            threadId,
            runId: runless ? null : runId,
            nodeId: runless ? null : nodeId,
            providerThreadId: cloud && !runless ? null : providerThreadId,
            providerTurnId: runless ? null : providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 10 + Number(runless),
            status: "running",
            title: "Background command",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "command_execution",
            input: "background work",
          },
        });
      }
    }
    const before = yield* projections.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-mixed-local-run"),
      threadId,
      runId: RunId.make("run:mixed:2"),
    });
    const after = yield* projections.getThreadProjection(threadId);
    assert.equal(after.runs.find((run) => run.ordinal === 2)?.status, "interrupted");
    assert.equal(
      after.attempts.find((attempt) => attempt.runId === "run:mixed:2")?.status,
      "interrupted",
    );
    assert.equal(after.nodes.find((node) => node.id === "node:mixed:2")?.status, "interrupted");
    assert.equal(
      after.turnItems.find((item) => item.id === "item:mixed:2:false")?.status,
      "interrupted",
    );
    assert.deepEqual(
      after.providerThreads.find((thread) => thread.id === "provider-thread:mixed:2")
        ?.pendingBackgroundTasks,
      [],
    );
    const cloudHistory = (projection: typeof before) => ({
      run: projection.runs.find((run) => run.ordinal === 1),
      attempt: projection.attempts.find((attempt) => attempt.runId === "run:mixed:1"),
      node: projection.nodes.find((node) => node.id === "node:mixed:1"),
      thread: projection.providerThreads.find((thread) => thread.id === "provider-thread:mixed:1"),
      turn: projection.providerTurns.find((turn) => turn.id === "provider-turn:mixed:1"),
      items: projection.turnItems.filter((item) => item.id.startsWith("item:mixed:1:")),
    });
    assert.lengthOf(cloudHistory(after).items, 2);
    assert.deepEqual(cloudHistory(after), cloudHistory(before));
    const settle = yield* orchestrator.dispatch({
      type: "thread.background-work.settle",
      commandId: CommandId.make("mixed-local-background-settle"),
      threadId,
      providerThreadId: ProviderThreadId.make("provider-thread:mixed:2"),
      providerTurnId: ProviderTurnId.make("provider-turn:mixed:2"),
    });
    assert.lengthOf(settle.storedEvents, 0);
    assert.deepEqual(
      cloudHistory(yield* projections.getThreadProjection(threadId)),
      cloudHistory(before),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["succeeded", "cancelled"] as const)(
  "cloud background repair preserves running attempts and parent delivery until adapter %s",
  (outcome) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const delivered = yield* Deferred.make<void>();
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: `cloud-background-repair-${outcome}` },
        ProviderAdapterRegistry.layerFromAdapters([fake.adapter]),
        {
          runEffectWorker: false,
          continuationRequests: Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            {
              offer: (request) =>
                Effect.sync(() => offers.push(request)).pipe(
                  Effect.andThen(Deferred.succeed(delivered, undefined)),
                  Effect.asVoid,
                ),
              take: Effect.never,
            },
          ),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
        const parentId = ThreadId.make("thread:cloud-background-parent");
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cloud-background-parent-create"),
          threadId: parentId,
          projectId: ProjectId.make("project:cloud-background"),
          title: "Parent",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cloud-background-parent-run"),
          threadId: parentId,
          messageId: MessageId.make("message:cloud-background-parent"),
          text: "Delegate cloud work",
          attachments: [],
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { type: "root", branch: "dev" },
          },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
        yield* projections.apply({
          id: EventId.make("cloud-background-parent-running"),
          type: "run.updated",
          threadId: parentId,
          occurredAt: now,
          payload: { ...parentRun, status: "running", startedAt: now },
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("cloud-background-delegate"),
          parentThreadId: parentId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Cloud work",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
        const childId = task.childThreadId!;
        const child = yield* orchestrator.getThreadProjection(childId);
        const run = child.runs[0]!;
        const attempt = child.attempts[0]!;
        const root = child.nodes.find((node) => node.id === run.rootNodeId)!;
        const providerThread = child.providerThreads[0]!;
        const providerTurnId = ProviderTurnId.make(`provider-turn:fake-cloud:${attempt.id}`);
        const cloudTask = {
          taskId: "remote-task-1",
          status: "running" as const,
          tracking: "live" as const,
          url: "https://example.com/tasks/1",
          source: {
            repository: "https://github.com/acme/repo",
            branch: "dev",
            sha: "a".repeat(40),
          },
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        for (const event of [
          { type: "run.updated", payload: { ...run, status: "running", startedAt: now } },
          {
            type: "run-attempt.updated",
            payload: { ...attempt, status: "running", startedAt: now, providerTurnId },
          },
          {
            type: "node.updated",
            payload: {
              ...root,
              status: "running",
              startedAt: now,
              providerThreadId: providerThread.id,
              providerTurnId,
            },
          },
          {
            type: "provider-thread.updated",
            payload: {
              ...providerThread,
              status: "active",
              cloudTask,
              nativeThreadRef: {
                driver: fakeCloudDriver,
                nativeId: "native-session-1",
                strength: "strong",
              },
            },
          },
          {
            type: "provider-turn.updated",
            payload: {
              id: providerTurnId,
              providerThreadId: providerThread.id,
              nodeId: root.id,
              runAttemptId: attempt.id,
              nativeTurnRef: {
                driver: fakeCloudDriver,
                nativeId: cloudTask.taskId,
                strength: "strong",
              },
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ] as const) {
          yield* projections.apply({
            ...event,
            id: EventId.make(`cloud-background-saved:${event.type}`),
            threadId: childId,
            occurredAt: now,
          });
        }
        assert.isNotNull(providerThread.providerSessionId);
        assert.isTrue(Option.isNone(yield* sessions.get(providerThread.providerSessionId!)));
        const settle = {
          type: "thread.background-work.settle",
          commandId: CommandId.make("cloud-background-settle"),
          threadId: childId,
          providerThreadId: providerThread.id,
          providerTurnId,
        } as const;
        const saved = yield* orchestrator.getThreadProjection(childId);
        const stop = yield* orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("cloud-background-stop-without-runtime"),
            threadId: childId,
            runId: run.id,
          })
          .pipe(Effect.exit);
        assert.equal(stop._tag, "Failure");
        assert.deepEqual(yield* orchestrator.getThreadProjection(childId), saved);
        assert.equal(yield* Ref.get(fake.cancellations), 0);
        for (const command of [
          settle,
          { ...settle, commandId: CommandId.make("cloud-background-settle-again") },
        ]) {
          assert.lengthOf((yield* orchestrator.dispatch(command)).storedEvents, 0);
          assert.deepEqual(yield* orchestrator.getThreadProjection(childId), saved);
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery,
            task.completionDelivery,
          );
        }
        assert.equal(task.completionDelivery?.state, "pending");
        assert.lengthOf(offers, 0);
        yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
          threadId: childId,
          runId: run.id,
          reattach: true,
        });
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(yield* Ref.get(fake.attachments), 1);
        const attached = yield* orchestrator.getThreadProjection(childId);
        const attachedSettle = yield* orchestrator.dispatch({
          ...settle,
          commandId: CommandId.make("cloud-background-settle-with-runtime"),
        });
        assert.lengthOf(attachedSettle.storedEvents, 0);
        assert.deepEqual(yield* orchestrator.getThreadProjection(childId), attached);
        assert.equal(attached.runs[0]?.status, "running");
        assert.equal(attached.attempts[0]?.status, "running");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery,
          task.completionDelivery,
        );
        yield* fake.finish(false, outcome);
        yield* Deferred.await(delivered);
        const finished = yield* orchestrator.getThreadProjection(childId);
        const expectedStatus = outcome === "succeeded" ? "completed" : "cancelled";
        assert.equal(finished.runs[0]?.status, expectedStatus);
        assert.equal(finished.attempts[0]?.status, expectedStatus);
        assert.equal(finished.providerThreads[0]?.cloudTask?.status, outcome);
        assert.equal(
          finished.messages.filter((message) => message.id === `message:cloud-result:${run.id}`)
            .length,
          1,
        );
        assert.lengthOf(offers, 1);
        const delivery = offers[0]!.delegatedCompletion!;
        // An offer is recoverable until the continuation consumer commits its message.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cloud-background-deliver-result"),
          threadId: parentId,
          messageId: delivery.messageId,
          text: "The delegated cloud task has returned its result.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: delivery.parentRunId,
            generation: delivery.generation,
            taskIds: [task.id],
          },
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.lengthOf(offers, 1);
        const parent = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(parent.subagents[0]?.completionDelivery?.state, "claimed");
        assert.equal(
          parent.messages.filter((message) => message.delegatedCompletion !== undefined).length,
          1,
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped),
);
