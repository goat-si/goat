import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as Rollback from "./CheckpointRollbackService.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import * as ThreadTitle from "./ThreadTitleRegenerationService.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ProviderAdapterTurnStartError } from "@goat/provider-core/server/ProviderAdapter";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as RemoteReportInbox from "../remoteReports/RemoteReportInbox.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Checkpoints from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Ingestor from "./ProviderEventIngestor.ts";
import * as Execution from "./RunExecutionService.ts";
import * as Finalization from "./RunFinalizationService.ts";
import * as Policy from "./CommandPolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  makeFakeCloudAdapter,
  fakeCloudCapabilities,
  fakeCloudDriver,
  fakeCloudInstanceId,
} from "./testkit/FakeCloudAdapter.ts";
import {
  CLOUD_DELIVERY_REJECTED_CODE,
  canCheckpoint,
  cloudFollowUpReason,
} from "@goat/provider-core/server/cloudTask";
import { makeProviderFailure } from "@goat/provider-core/server/failure";

it.effect.each([
  { linkOnly: false, reattach: false, reportedRejection: false },
  { linkOnly: true, reattach: false, reportedRejection: false },
  { linkOnly: false, reattach: true, reportedRejection: false },
  { linkOnly: true, reattach: true, reportedRejection: false },
  { linkOnly: true, reattach: true, reportedRejection: true },
])(
  "settles cloud linkOnly=$linkOnly reattach=$reattach reportedRejection=$reportedRejection without checkpoints",
  ({ linkOnly, reattach, reportedRejection }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const fake = yield* makeFakeCloudAdapter();
      const threadId = ThreadId.make("thread:cloud-foundation");
      const runId = RunId.make("run:cloud-foundation");
      const attemptId = RunAttemptId.make("attempt:cloud-foundation");
      const rootNodeId = NodeId.make("node:cloud-foundation");
      const providerThreadId = ProviderThreadId.make("pt:cloud-foundation");
      const providerSessionId = ProviderSessionId.make("ps:cloud-foundation");
      const messageId = MessageId.make("message:cloud-foundation");
      const modelSelection = { instanceId: fakeCloudInstanceId, model: "fake" };
      const projection = idleThreadProjection(liveThreadShell(threadId, { activeRunId: null }));
      const appThread = {
        ...projection.thread,
        providerInstanceId: fakeCloudInstanceId,
        modelSelection,
      };
      const source = {
        repository: "https://github.com/acme/repo",
        branch: "dev",
        sha: "a".repeat(40),
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: fakeCloudDriver,
        providerInstanceId: fakeCloudInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: reattach
          ? { driver: fakeCloudDriver, nativeId: "native-session-1", strength: "strong" }
          : null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        cloudTask: {
          taskId: reattach ? "remote-task-1" : runId,
          status: reattach ? "running" : "submitting",
          tracking: "live",
          source,
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        },
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: fakeCloudInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const rootNode: OrchestrationV2ExecutionNode = {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const attempt: OrchestrationV2RunAttempt = {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: fakeCloudInstanceId,
        providerThreadId,
        providerTurnId: reattach
          ? ProviderTurnId.make(`provider-turn:fake-cloud:${attemptId}`)
          : null,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: "/repo",
        approvalPolicy: "never" as const,
        sandboxPolicy: {
          type: "readOnly" as const,
          access: { type: "fullAccess" as const },
          networkAccess: false,
        },
      };
      const session = yield* fake.adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const ended = yield* Deferred.make<void>();
      const observerClosed = yield* Deferred.make<void>();
      const followupEnded = yield* Deferred.make<void>();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO remote_report_inbox
      (origin_thread_id, correlation_id, kind, text, created_at)
      VALUES (${threadId}, 'ci-report', 'progress', 'Durable pending report', ${DateTime.formatIso(now)})`;
      const reads = yield* Ref.make(0);
      const consumes = yield* Ref.make(0);
      const inboxLayer = Layer.effect(
        RemoteReportInbox.RemoteReportInbox,
        Effect.gen(function* () {
          const inbox = yield* RemoteReportInbox.RemoteReportInbox;
          return RemoteReportInbox.RemoteReportInbox.of({
            pending: (id) =>
              Ref.update(reads, (n) => n + 1).pipe(Effect.andThen(inbox.pending(id))),
            consume: (id, throughId) =>
              Ref.update(consumes, (n) => n + 1).pipe(Effect.andThen(inbox.consume(id, throughId))),
          });
        }),
      ).pipe(Layer.provide(RemoteReportInbox.layer));
      const events: OrchestrationV2DomainEvent[] = [];
      const captures = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const executionLayer = Execution.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            inboxLayer,
            IdAllocator.layer,
            ServerSettings.layerTest(),
            Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
              allocate: () => Effect.succeed(1),
            }),
            Layer.mock(Checkpoints.CheckpointServiceV2)({
              captureBaseline: () => Ref.update(captures, (n) => n + 1),
            }),
            Layer.mock(Ingestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  events.push(...input.events);
                  assert.equal(input.effects?.length ?? 0, 0);
                  if (
                    input.events.some(
                      (event) =>
                        event.type === "run.updated" && event.payload.status === "completed",
                    )
                  ) {
                    yield* Deferred.succeed(ended, undefined);
                  }
                  if (
                    input.events.some(
                      (event) =>
                        event.type === "run.updated" &&
                        event.payload.id !== runId &&
                        (event.payload.status === "completed" || event.payload.status === "failed"),
                    )
                  ) {
                    yield* Deferred.succeed(followupEnded, undefined);
                  }
                  return { committed: true, storedEvents: [] } as never;
                }),
            }),
            Layer.succeed(Finalization.RunFinalizationObserver, {
              refreshAfterTurn: () => Ref.update(refreshes, (n) => n + 1),
              refresh: () => Ref.update(refreshes, (n) => n + 1),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const startInput: Execution.RunExecutionServiceV2StartRootRunInput = {
          commandId: CommandId.make("command:cloud-foundation"),
          appThread,
          providerSessionId,
          session: {
            ...session,
            subscribeEvents: Effect.succeed({
              events: session.events,
              close: Deferred.succeed(observerClosed, undefined).pipe(Effect.asVoid),
            }),
          },
          run,
          rootNode,
          checkpointScope: null,
          reattach,
          cloudSource: source,
          providerThread,
          attempt,
          attemptId,
          providerTurnOrdinal: 1,
          modelSelection,
          runtimePolicy,
          shouldFinalizeRun: () => Effect.succeed(true),
          message: {
            messageId,
            text: "Work remotely",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        };
        const execution = yield* Execution.RunExecutionServiceV2;
        yield* execution.startRootRun(startInput);
        if (reattach) yield* execution.startRootRun(startInput);
        yield* fake.finish(linkOnly);
        yield* Deferred.await(ended);
        yield* Deferred.await(observerClosed);
        assert.equal(yield* Ref.get(reads), reattach ? 0 : 1);
        assert.equal(yield* Ref.get(consumes), reattach ? 0 : 1);
        const pending =
          yield* sql`SELECT text FROM remote_report_inbox WHERE origin_thread_id = ${threadId}`;
        assert.equal(pending.length, reattach ? 1 : 0);
        if (reattach) {
          const followupRunId = RunId.make("run:cloud-report-followup");
          const followupAttemptId = RunAttemptId.make("attempt:cloud-report-followup");
          const failedSend = linkOnly;
          const followupSession = reportedRejection
            ? {
                ...session,
                startTurn: (input: Parameters<typeof session.startTurn>[0]) =>
                  Effect.gen(function* () {
                    const at = yield* DateTime.now;
                    const turnId = ProviderTurnId.make(`provider-turn:rejected:${input.attemptId}`);
                    yield* input.commitCloudTask!(
                      {
                        ...providerThread.cloudTask!,
                        taskId: "remote-task-1",
                        url: "https://example.com/tasks/1",
                        status: "running",
                        progress: "Follow-up rejected",
                        summary: "Follow-up rejected; the cloud session is still available.",
                        updatedAt: DateTime.formatIso(at),
                      },
                      {
                        nativeThreadRef: {
                          driver: fakeCloudDriver,
                          nativeId: "native-session-1",
                          strength: "strong",
                        },
                        nativeConversationHeadRef: null,
                      },
                    );
                    yield* fake.publish({
                      type: "provider_turn.updated",
                      driver: fakeCloudDriver,
                      threadId,
                      providerTurn: {
                        id: turnId,
                        providerThreadId,
                        nodeId: input.rootNodeId,
                        runAttemptId: input.attemptId,
                        nativeTurnRef: null,
                        ordinal: input.providerTurnOrdinal,
                        status: "running",
                        startedAt: at,
                        completedAt: null,
                      },
                    });
                    yield* fake.publish({
                      type: "turn.terminal",
                      driver: fakeCloudDriver,
                      providerThreadId,
                      providerTurnId: turnId,
                      runOrdinal: input.runOrdinal,
                      status: "failed",
                      failure: makeProviderFailure({
                        class: "provider_error",
                        code: CLOUD_DELIVERY_REJECTED_CODE,
                        message: "Follow-up rejected",
                        retryable: false,
                      }),
                      failureItemOrdinal: 1,
                      threadDisposition: "reusable",
                    });
                  }),
              }
            : failedSend
              ? {
                  ...session,
                  startTurn: () =>
                    Effect.fail(
                      new ProviderAdapterTurnStartError({
                        driver: fakeCloudDriver,
                        threadId,
                        runId: followupRunId,
                        providerThreadId,
                        cause: "Send refused before remote acceptance",
                      }),
                    ),
                }
              : session;
          yield* execution.startRootRun({
            ...startInput,
            reattach: false,
            session: followupSession,
            run: { ...run, id: followupRunId, ordinal: 2, activeAttemptId: followupAttemptId },
            attemptId: followupAttemptId,
            attempt: {
              ...attempt,
              id: followupAttemptId,
              runId: followupRunId,
              providerTurnId: null,
            },
            rootNode: { ...rootNode, runId: followupRunId },
            providerTurnOrdinal: 2,
          });
          assert.equal(yield* Ref.get(reads), 1);
          assert.equal(yield* Ref.get(consumes), failedSend && !reportedRejection ? 0 : 1);
          const retained =
            yield* sql`SELECT text FROM remote_report_inbox WHERE origin_thread_id = ${threadId}`;
          assert.equal(retained.length, failedSend && !reportedRejection ? 1 : 0);
          if (!failedSend) {
            const sent = yield* Ref.get(fake.current);
            assert.equal(sent?.providerThread.nativeThreadRef?.nativeId, "native-session-1");
            assert.equal(sent?.message.text.split("Durable pending report").length, 2);
            yield* fake.finish();
          }
          yield* Deferred.await(followupEnded);
          const savedFollowup = events.findLast(
            (event) => event.type === "provider-thread.updated",
          );
          assert.equal(savedFollowup?.type, "provider-thread.updated");
          if (savedFollowup?.type === "provider-thread.updated" && failedSend) {
            assert.equal(
              savedFollowup.payload.cloudTask?.status,
              reportedRejection ? "running" : "unknown",
            );
            const reason = cloudFollowUpReason(
              { providerThreads: [savedFollowup.payload], runs: [] },
              fakeCloudInstanceId,
              fakeCloudCapabilities(),
            );
            if (reportedRejection) {
              assert.isNull(reason);
              assert.equal(savedFollowup.payload.nativeThreadRef?.nativeId, "native-session-1");
              assert.equal(savedFollowup.payload.cloudTask?.taskId, "remote-task-1");
              assert.equal(
                events.filter(
                  (event) => event.type === "message.updated" && event.runId === followupRunId,
                ).length,
                1,
              );
            } else {
              assert.isString(reason);
            }
          }
        }
      }).pipe(Effect.provide(executionLayer));
      assert.equal(yield* Ref.get(captures), 0);
      assert.equal(yield* Ref.get(refreshes), 0);
      assert.equal(yield* Ref.get(fake.submissions), reattach && linkOnly ? 0 : 1);
      assert.equal(yield* Ref.get(fake.creations), reattach ? 0 : 1);
      assert.equal(yield* Ref.get(fake.attachments), reattach ? 1 : 0);
      const settled = events.findLast(
        (event) => event.type === "run.updated" && event.payload.id === runId,
      );
      assert.equal(settled?.type === "run.updated" ? settled.payload.status : null, "completed");
      assert.isNotNull(settled?.type === "run.updated" ? settled.payload.completedAt : null);
      const terminalIndex = events.findIndex(
        (event) => event.type === "run.updated" && event.payload.id === runId,
      );
      const taskEvent = events
        .slice(0, terminalIndex + 3)
        .findLast((event) => event.type === "provider-thread.updated");
      assert.equal(
        taskEvent?.type === "provider-thread.updated" ? taskEvent.payload.cloudTask?.status : null,
        linkOnly ? "running" : "succeeded",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "message.updated" &&
            event.payload.text.includes("https://example.com/tasks/1"),
        ),
      );
      assert.isFalse(events.some((event) => event.type === "checkpoint.captured"));
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reserves one-shot follow-up admission and rejects queued/MCP service calls", () =>
  Effect.gen(function* () {
    const projection = idleThreadProjection(
      liveThreadShell(ThreadId.make("thread:one-shot"), { activeRunId: null }),
    );
    const policy = yield* Policy.CommandPolicyV2;
    const input = {
      commandId: CommandId.make("command:one-shot"),
      threadId: projection.thread.id,
      providerInstanceId: fakeCloudInstanceId,
      capabilities: fakeCloudCapabilities(false),
      projection,
    };
    yield* policy.ensureFollowUp(input);
    const reserved = {
      ...projection,
      runs: [
        {
          id: RunId.make("run:reserved"),
          status: "starting",
          providerInstanceId: fakeCloudInstanceId,
        } as OrchestrationV2Run,
      ],
    };
    const error = yield* policy
      .ensureFollowUp({ ...input, projection: reserved })
      .pipe(Effect.flip);
    assert.equal(error._tag, "CommandPolicyCapabilityUnsupportedError");
    if (error._tag === "CommandPolicyCapabilityUnsupportedError")
      assert.equal(error.detail, "Fake Cloud has no follow-up");
    yield* policy.ensureFollowUp({
      ...input,
      projection: reserved,
      excludingRunId: reserved.runs[0]!.id,
    });
    yield* policy.ensureFollowUp({
      ...input,
      projection: {
        ...projection,
        runs: [{ ...reserved.runs[0]!, status: "failed", startedAt: null }],
      },
    });
    const acceptedFailure = {
      ...projection,
      runs: [{ ...reserved.runs[0]!, status: "failed" as const, startedAt: yield* DateTime.now }],
    };
    const stillBlocked = yield* policy
      .ensureFollowUp({ ...input, projection: acceptedFailure })
      .pipe(Effect.flip);
    assert.equal(stillBlocked._tag, "CommandPolicyCapabilityUnsupportedError");
  }).pipe(Effect.provide(Policy.layer)),
);

it.effect("disposing a cloud observer never cancels the remote task", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter();
    yield* fake.adapter
      .openSession({
        threadId: ThreadId.make("thread:detach"),
        providerSessionId: ProviderSessionId.make("ps:detach"),
        modelSelection: { instanceId: fakeCloudInstanceId, model: "fake" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/repo",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      })
      .pipe(Effect.scoped);
    assert.equal(yield* Ref.get(fake.detaches), 1);
    assert.equal(yield* Ref.get(fake.cancellations), 0);
    assert.equal(yield* Ref.get(fake.submissions), 0);
  }),
);

const decodeEffect = Schema.decodeUnknownSync(EffectOutbox.OrchestrationEffectRequestV2);

it("reattachment is decodable and replay-safe while submission remains process-bound", () => {
  const request = decodeEffect({
    type: "provider-turn.reattach",
    runId: "run:recover-existing-cloud-task",
  });
  assert.equal(request.type, "provider-turn.reattach");
  const replaySafe = new Set<string>(EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS);
  const processBound = new Set<string>(EffectOutbox.PROCESS_BOUND_EFFECT_TYPES);
  assert.isTrue(replaySafe.has(request.type));
  assert.isFalse(replaySafe.has("provider-turn.start"));
  assert.isTrue(processBound.has("provider-turn.start"));
});

it("local checkpoint admission depends on execution location", () => {
  const capabilities = fakeCloudCapabilities();
  assert.isFalse(canCheckpoint(capabilities));
  assert.isTrue(
    canCheckpoint({
      ...capabilities,
      sessions: {
        ...capabilities.sessions,
        executionLocation: "local",
      },
    }),
  );
});

it.effect.each([false, true])(
  "real worker retains typed tracking failure cloud=%s despite already-stopped text",
  (cloud) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:tracking-failure");
      const providerTurnId = ProviderTurnId.make("turn:tracking-failure");
      const commandId = CommandId.make("command:tracking-failure");
      const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
      const settlements: string[] = [];
      const executor = EffectWorker.layerExecutor.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({
              interrupt: () =>
                Effect.fail(
                  new ProviderTurnControl.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    ...(cloud ? { reason: "tracking-unavailable" as const } : {}),
                    cause: new Error("Provider session is not active; treating as already stopped"),
                  }),
                ),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  settlements.push(command.type);
                  return {} as never;
                }),
            }),
            Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({}),
            Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
            Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
            Layer.mock(Rollback.CheckpointRollbackServiceV2)({}),
            Layer.mock(Finalization.RunFinalizationService)({}),
            Layer.mock(ResourceCleanup.ResourceCleanupService)({}),
            Layer.mock(ThreadTitle.ThreadTitleRegenerationService)({}),
            ServerSettings.layerTest(),
          ),
        ),
      );
      const workerLayer = EffectWorker.layerWithOptions({
        workerId: "cloud-test",
        maxAttempts: 1,
      }).pipe(Layer.provide(Layer.merge(outboxLayer, executor)));
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: "effect:tracking-failure",
            commandId,
            threadId,
            request: {
              type: "provider-turn.interrupt",
              providerTurnId,
              providerThreadId: ProviderThreadId.make("pt:tracking-failure"),
              providerSessionId: ProviderSessionId.make("ps:tracking-failure"),
            },
          },
        ]);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        const effect = yield* outbox.get("effect:tracking-failure");
        assert.isTrue(Option.isSome(effect));
        if (Option.isSome(effect))
          assert.equal(effect.value.status, cloud ? "failed" : "succeeded");
        assert.deepEqual(settlements, cloud ? [] : ["thread.background-work.settle"]);
      }).pipe(Effect.provide(Layer.merge(workerLayer, outboxLayer)));
    }),
);

it.effect.each(["running", "completed"] as const)(
  "missing tracking refuses cloud interrupt for %s observation",
  (status) =>
    Effect.gen(function* () {
      const providerThreadId = ProviderThreadId.make("pt:lost-cloud-tracking");
      const providerTurnId = ProviderTurnId.make("turn:lost-cloud-tracking");
      const providerSessionId = ProviderSessionId.make("ps:lost-cloud-tracking");
      const threadId = ThreadId.make("thread:lost-cloud-tracking");
      const context = {
        providerThread: {
          id: providerThreadId,
          providerSessionId,
          cloudTask: {
            taskId: "remote-task",
            status: "running",
            tracking: status === "completed" ? "link-only" : "live",
            url: "https://example.com/tasks/saved",
            source: { repository: "https://github.com/acme/repo", branch: "dev" },
            localChangesExcluded: true,
            updatedAt: "2026-10-13T00:00:00.000Z",
          },
        },
        providerTurn: { id: providerTurnId, providerThreadId, status },
      } as unknown as ProjectionStore.ProjectionProviderControlContext;
      const layer = ProviderTurnControl.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () => Effect.succeed(context),
            }),
            Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
              get: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      );
      const error = yield* ProviderTurnControl.ProviderTurnControlServiceV2.pipe(
        Effect.flatMap((service) =>
          service.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId }),
        ),
        Effect.flip,
        Effect.provide(layer),
      );
      assert.equal(error.reason, "tracking-unavailable");
      assert.equal(context.providerThread?.cloudTask?.status, "running");
      assert.equal(context.providerTurn?.status, status);
    }),
);
