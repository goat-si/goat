import { seedQueuedStarts, assertQueuedStarts } from "./ProviderRuntimeQueuedStart.testkit.ts";
import { survivorRecords } from "./ProviderRuntimeRecoverySurvivorRecords.testkit.ts";
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as EffectOutbox from "./EffectOutbox.ts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ServerSettings from "../serverSettings.ts";
import * as Detached from "../provider/CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError as DetachedError } from "../provider/CodexDetachedAppServer.ts";
import * as Survivors from "../provider/CodexSurvivors.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layerTest, makeThread, threadCreatedEvent } from "./FoundationPersistence.testkit.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
export const recoveryScenario = (
  survival: "off" | "restart" | "always",
  ordinaryContinuation: boolean,
  terminalStatus: "completed" | "failed" | "interrupted" = "completed",
  mixed = false,
  reviewCase?:
    | "ordinary"
    | "ordinary-record"
    | "gone"
    | "unknown"
    | "unknown-native"
    | "missing"
    | "preserve-failure"
    | "stopped"
    | "stop-completed"
    | "stop-clear-crash"
    | "goal-release"
    | "goal-held"
    | "unreadable"
    | "no-root",
) =>
  Effect.gen(function* () {
    const bindings = yield* Ref.make<ReadonlyArray<Survivors.CodexSurvivorBinding>>([]);
    const order: string[] = [];
    const u = { thread: "old-native", id: "U", status: "running" as const };
    let oldGoalBlocked = true;
    let pendingStop = reviewCase === "stop-clear-crash";
    let clearAttempts = 0;
    let saltedChecks = 0;
    const records = survivorRecords(reviewCase);
    const mockDetached = Layer.mock(Detached.CodexDetachedAppServers)({
      socketTransportEnabled: reviewCase !== "ordinary",
      loadRecords: Effect.sync(() => {
        order.push("load");
        const loaded = records.map((record) => ({
          ...record,
          ...(!oldGoalBlocked ? { goalBlocks: [] } : {}),
          ...(!pendingStop ? { stopObligations: [] } : {}),
        }));
        return Object.assign(
          loaded,
          reviewCase === "unreadable"
            ? { globalBlock: "A Codex process record is unreadable." }
            : {},
        );
      }),
      preserveForRecovery: (name) =>
        name === "codex-salted-abcdefabcdef" && reviewCase === "preserve-failure"
          ? Effect.fail(new DetachedError({ detail: "process identity changed" }))
          : Effect.sync(() => {
              order.push(`preserve:${name}`);
            }).pipe(Effect.as(undefined)),
    });
    const mockSurvivors = Layer.mock(Survivors.CodexSurvivors)({
      list: Ref.get(bindings),
      startBlockedThreads: Ref.get(bindings).pipe(
        Effect.map((items) => items.map((item) => item.threadId)),
      ),
      setStartWake: () => Effect.void,
      classifyRecord: (key) =>
        Effect.sync(
          () =>
            ({
              type:
                key.instanceId === "codex-salted" &&
                (reviewCase === "gone" || (reviewCase === "preserve-failure" && ++saltedChecks > 1))
                  ? "gone"
                  : key.instanceId === "codex-salted" && reviewCase === "unknown"
                    ? "unverifiable"
                    : "verified",
              pgid: 1002,
              members: [],
            }) as never,
        ),
      replace: (value) => Ref.set(bindings, value),
      classifyExisting: (binding, stopRequested) => {
        const client = {
          setRequestGuard: () => Effect.void,
          handleServerNotification: () => Effect.void,
          request: (method: string) =>
            Effect.sync(() => {
              if (method === "thread/goal/get")
                return {
                  goal: ["goal", "shared"].includes(binding.threadId) ? { status: "active" } : null,
                };
              if (method === "turn/interrupt") order.push("interrupt");
              if (method === "thread/turns/list")
                return {
                  data: [
                    {
                      id: binding.nativeTurnId,
                      status:
                        reviewCase === "stop-completed" &&
                        binding.threadId === ThreadId.make("stop")
                          ? "completed"
                          : "interrupted",
                    },
                  ],
                };
              return {};
            }),
        } as unknown as CodexClient.CodexAppServerClient["Service"];
        return Effect.sync(() => {
          order.push(`classify:${binding.threadId}`);
        }).pipe(
          Effect.andThen(
            Survivors.classifyOnControl({
              binding,
              stopRequested,
              client,
              recordGoal: () =>
                Effect.sync(() => {
                  order.push("goal-fence");
                }),
              recordStop: () =>
                Effect.sync(() => {
                  order.push("stop-fence");
                }),
            }),
          ),
          Effect.mapError((cause) => new DetachedError({ detail: "fake control failed", cause })),
        );
      },
      getStopObligations: (threadId) =>
        Effect.succeed(
          reviewCase === "stop-clear-crash" && pendingStop && threadId === ThreadId.make("stop")
            ? [
                {
                  record: {
                    instanceId: ProviderInstanceId.make("codex-stop"),
                    recordName: "codex-stop-abcdefabcdef",
                  },
                  block: {
                    threadId,
                    nativeThreadId: "native-stop",
                    nativeTurnId: "turn-native-stop",
                  },
                },
              ]
            : reviewCase === "goal-held" && threadId === ThreadId.make("old-goal")
              ? [
                  {
                    record: {
                      instanceId: ProviderInstanceId.make("codex-plain"),
                      recordName: "codex-plain-abcdefabcdef",
                    },
                    block: { threadId, nativeThreadId: "old-native", nativeTurnId: "old-turn" },
                  },
                ]
              : [],
        ),
      recordStopObligation: () =>
        Effect.sync(() => {
          order.push("record-obligation");
        }),
      blockThread: (threadId) =>
        Effect.sync(() => {
          order.push("block-thread", `block:${threadId}`);
        }),
      clearStopObligation: (_key, obligation) =>
        Effect.gen(function* () {
          if (
            reviewCase === "stop-clear-crash" &&
            obligation.threadId === ThreadId.make("stop") &&
            ++clearAttempts === 1
          )
            return yield* new DetachedError({ detail: "write interrupted" });
          if (obligation.threadId === ThreadId.make("stop")) pendingStop = false;
          order.push("clear-obligation");
        }),
      clearGoalBlock: () =>
        Effect.sync(() => {
          order.push("clear-goal");
          oldGoalBlocked = false;
        }),
      readExistingGoal: () =>
        Effect.sync(() => {
          order.push("read-goal");
          return "none" as const;
        }),
      readExistingTurn: (_, t, id) =>
        Effect.succeed(t === u.thread && id === u.id ? u.status : "interrupted"),
    });
    const layer = Recovery.layer.pipe(
      Layer.provideMerge(mockDetached),
      Layer.provideMerge(mockSurvivors),
      Layer.provideMerge(layerTest),
      Layer.provideMerge(
        ServerSettings.layerTest({
          continueThreadsAfterServerUpdate: ordinaryContinuation,
          codexTurnsSurviveServerStop: survival,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      for (const kind of ["plain", "goal", "salted", "stop", "terminal", "shared"]) {
        const threadId = ThreadId.make(kind);
        const instance = ProviderInstanceId.make(`codex-${kind === "shared" ? "plain" : kind}`);
        const driver = ProviderDriverKind.make(
          kind === "goal" && reviewCase === "unreadable" ? "claude" : "codex",
        );
        const model = { instanceId: instance, model: "gpt-5.4" };
        const thread = {
          ...makeThread(threadId, now),
          providerInstanceId: instance,
          modelSelection: model,
        };
        const sessionId = ProviderSessionId.make(`session-${kind === "shared" ? "plain" : kind}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread-${kind}`);
        const runId = RunId.make(`run-${kind}`);
        const attemptId = RunAttemptId.make(`attempt-${kind}`);
        const turnId =
          (kind === "salted" && reviewCase !== "ordinary" && reviewCase !== "ordinary-record") ||
          kind === "terminal"
            ? IdAllocator.derive.providerTurn({
                driver,
                nativeTurnId: `turn-native-${kind}:restart:${runId}`,
              })
            : ProviderTurnId.make(`turn-${kind}`);
        const nodeId = NodeId.make(`node-${kind}`);
        yield* store.apply(threadCreatedEvent({ id: `event:${kind}:thread`, thread, now }));
        yield* store.apply({
          id: EventId.make(`event:${kind}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: instance,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId: instance,
            status: "ready",
            cwd: "/workspace",
            model: model.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:${kind}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instance,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            appThreadId: threadId,
            ownerNodeId: null,
            driver,
            providerInstanceId: instance,
            providerSessionId: sessionId,
            nativeThreadRef:
              kind === "salted" &&
              (reviewCase === "ordinary-record" || reviewCase === "unknown-native")
                ? null
                : { driver, nativeId: `native-${kind}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            pendingBackgroundTasks: [],
          },
        });
        if (kind === "salted" || kind === "terminal") {
          const sourceId = RunId.make(`run-source-${kind}`);
          yield* store.apply({
            id: EventId.make(`event:${kind}:source`),
            type: "run.created",
            threadId,
            runId: sourceId,
            occurredAt: now,
            payload: {
              id: sourceId,
              threadId,
              ordinal: 1,
              providerInstanceId: instance,
              modelSelection: model,
              providerThreadId,
              userMessageId: MessageId.make(`message-source-${kind}`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "cancelled",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
        }
        yield* store.apply({
          id: EventId.make(`event:${kind}:run`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: kind === "salted" || kind === "terminal" ? 2 : 1,
            providerInstanceId: instance,
            modelSelection: model,
            providerThreadId,
            ...(kind === "salted" || kind === "terminal"
              ? { restartContinuationOfRunId: RunId.make(`run-source-${kind}`) }
              : {}),
            userMessageId: MessageId.make(`message-${kind}`),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:${kind}:attempt`),
          type: "run-attempt.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: instance,
            providerThreadId,
            providerTurnId: turnId,
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
        if (
          (kind === "terminal" && reviewCase !== "no-root") ||
          (mixed && kind === "plain") ||
          (reviewCase !== undefined && kind === "salted")
        ) {
          yield* store.apply({
            id: EventId.make(`event:${kind}:node`),
            type: "node.updated",
            threadId,
            runId,
            nodeId,
            providerInstanceId: instance,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: true,
              providerThreadId,
              providerTurnId: turnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
        }
        yield* store.apply({
          id: EventId.make(`event:${kind}:turn`),
          type: "provider-turn.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: turnId,
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: { driver, nativeId: `turn-native-${kind}`, strength: "strong" },
            ordinal: 1,
            status: kind === "terminal" ? terminalStatus : "running",
            startedAt: now,
            completedAt: kind === "terminal" ? now : null,
          },
        });
        if (kind === "stop") {
          yield* store.apply({
            id: EventId.make("event:stop:request"),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId,
            providerInstanceId: instance,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("stop-request"),
              threadId,
              runId,
              nodeId,
              providerThreadId,
              providerTurnId: turnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: "Stop requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "run_interrupt_request",
              message: "Stop",
            },
          });
        }
      }
      if (mixed) {
        const threadId = ThreadId.make("plain");
        const runId = RunId.make("run-plain");
        const rootId = NodeId.make("node-plain");
        const driver = ProviderDriverKind.make("codex");
        const instance = ProviderInstanceId.make("codex-plain");
        const sessionId = ProviderSessionId.make("session-plain");
        const childId = NodeId.make("native-child");
        const childThread = ProviderThreadId.make("native-child-thread");
        const childTurn = ProviderTurnId.make("native-child-turn");
        const staleNode = NodeId.make("stale-root");
        const staleThread = ProviderThreadId.make("stale-thread");
        const staleTurn = ProviderTurnId.make("stale-turn");
        const projection = yield* store.getThreadProjection(threadId);
        const template = projection.providerThreads[0];
        if (!template) throw new Error("Missing survivor provider thread");
        const other = yield* store.getThreadProjection(ThreadId.make("goal"));
        const otherRun = other.runs[0];
        const otherAttempt = other.attempts[0];
        const otherTurn = other.providerTurns[0];
        const otherThread = other.providerThreads[0];
        const otherSession = other.providerSessions[0];
        if (!otherRun || !otherAttempt || !otherTurn || !otherThread || !otherSession)
          throw new Error("Missing unrelated work");
        const otherInstance = ProviderInstanceId.make("codex-unrelated");
        const otherRunId = RunId.make("run-unrelated");
        const otherAttemptId = RunAttemptId.make("attempt-unrelated");
        const otherTurnId = ProviderTurnId.make("turn-unrelated");
        const otherThreadId = ProviderThreadId.make("provider-thread-unrelated");
        const otherSessionId = ProviderSessionId.make("session-unrelated");
        yield* store.apply({
          id: EventId.make("event:unrelated:session"),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: otherInstance,
          occurredAt: now,
          payload: { ...otherSession, id: otherSessionId, providerInstanceId: otherInstance },
        });
        yield* store.apply({
          id: EventId.make("event:unrelated:thread"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: otherInstance,
          occurredAt: now,
          payload: {
            ...otherThread,
            id: otherThreadId,
            appThreadId: threadId,
            providerInstanceId: otherInstance,
            providerSessionId: otherSessionId,
          },
        });
        yield* store.apply({
          id: EventId.make("event:unrelated:run"),
          type: "run.created",
          threadId,
          runId: otherRunId,
          occurredAt: now,
          payload: {
            ...otherRun,
            id: otherRunId,
            threadId,
            ordinal: 2,
            providerInstanceId: otherInstance,
            modelSelection: { ...otherRun.modelSelection, instanceId: otherInstance },
            providerThreadId: otherThreadId,
            activeAttemptId: otherAttemptId,
          },
        });
        yield* store.apply({
          id: EventId.make("event:unrelated:attempt"),
          type: "run-attempt.updated",
          threadId,
          runId: otherRunId,
          occurredAt: now,
          payload: {
            ...otherAttempt,
            id: otherAttemptId,
            runId: otherRunId,
            providerInstanceId: otherInstance,
            providerThreadId: otherThreadId,
            providerTurnId: otherTurnId,
          },
        });
        yield* store.apply({
          id: EventId.make("event:unrelated:turn"),
          type: "provider-turn.updated",
          threadId,
          runId: otherRunId,
          occurredAt: now,
          payload: {
            ...otherTurn,
            id: otherTurnId,
            providerThreadId: otherThreadId,
            runAttemptId: otherAttemptId,
          },
        });
        for (const [id, ownerNodeId] of [
          [childThread, childId],
          [staleThread, null],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:${id}`),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: instance,
            occurredAt: now,
            payload: {
              ...template,
              id,
              ownerNodeId,
              nativeThreadRef: { driver, nativeId: id, strength: "strong" },
            },
          });
        }
        for (const [id, nodeRunId, parentNodeId, pt, turn] of [
          [childId, runId, rootId, childThread, childTurn],
          [staleNode, null, null, staleThread, staleTurn],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:${id}:node`),
            type: "node.updated",
            threadId,
            driver,
            providerInstanceId: instance,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId: nodeRunId,
              parentNodeId,
              rootNodeId: id,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: pt,
              providerTurnId: turn,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* store.apply({
            id: EventId.make(`event:${id}:turn`),
            type: "provider-turn.updated",
            threadId,
            driver,
            occurredAt: now,
            payload: {
              id: turn,
              providerThreadId: pt,
              nodeId: id,
              runAttemptId: null,
              nativeTurnRef: { driver, nativeId: turn, strength: "strong" },
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          });
        }
        yield* store.apply({
          id: EventId.make("event:native-child:subagent"),
          type: "subagent.updated",
          threadId,
          runId,
          driver,
          providerInstanceId: instance,
          occurredAt: now,
          payload: {
            id: childId,
            threadId,
            runId,
            parentNodeId: rootId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: instance,
            providerThreadId: childThread,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "work",
            title: null,
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
        for (const [id, nodeId, providerTurnId, kind] of [
          ["approval", rootId, ProviderTurnId.make("turn-plain"), "command"],
          ["question", NodeId.make("question-node"), null, "user_input"],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:${id}:request`),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make(id),
              nodeId,
              providerTurnId,
              nativeRequestRef: null,
              kind,
              status: "pending",
              responseCapability: { type: "live", providerSessionId: sessionId },
              createdAt: now,
              resolvedAt: null,
            },
          });
        }
        yield* store.apply({
          id: EventId.make("event:question:item"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("question-item"),
            threadId,
            runId: null,
            nodeId: NodeId.make("question-node"),
            providerThreadId: staleThread,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId: RuntimeRequestId.make("question"),
            questions: [
              {
                id: "q",
                header: "Choice",
                question: "Choose",
                options: [],
                multiSelect: false,
                allowCustomAnswer: true,
              },
            ],
          },
        });
      }
      const outboxBefore = yield* EffectOutbox.EffectOutboxV2;
      yield* outboxBefore.enqueue([
        {
          id: "effect:restart-continuation:run-source-terminal",
          commandId: CommandId.make("command:terminal"),
          threadId: ThreadId.make("terminal"),
          request: {
            type: "provider-runtime.continue",
            sourceRunId: RunId.make("run-source-terminal"),
          },
        },
      ]);
      if (reviewCase === "gone" || reviewCase === "preserve-failure")
        yield* outboxBefore.enqueue([
          {
            id: "effect:restart-continuation:run-source-salted",
            commandId: CommandId.make("command:source-salted"),
            threadId: ThreadId.make("salted"),
            request: {
              type: "provider-runtime.continue",
              sourceRunId: RunId.make("run-source-salted"),
            },
          },
        ]);
      if (mixed)
        yield* outboxBefore.enqueue([
          {
            id: "survivor-start",
            commandId: CommandId.make("command:survivor-start"),
            threadId: ThreadId.make("salted"),
            request: { type: "provider-turn.start", runId: RunId.make("run-salted") },
          },
          {
            id: "unrelated-start",
            commandId: CommandId.make("command:unrelated-start"),
            threadId: ThreadId.make("plain"),
            request: { type: "provider-turn.start", runId: RunId.make("run-unrelated") },
          },
          {
            id: "unrelated-cleanup",
            commandId: CommandId.make("command:unrelated-cleanup"),
            threadId: ThreadId.make("plain"),
            request: { type: "terminal.cleanup" },
          },
        ]);
      if (mixed) {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'old-server' WHERE effect_id = 'survivor-start'`;
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'old-server' WHERE effect_id = 'unrelated-cleanup'`;
      }
      if (mixed) yield* seedQueuedStarts(store, outboxBefore, now);
      yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      if (mixed) yield* assertQueuedStarts(store, outboxBefore, order);
      if (reviewCase) {
        const salted = yield* store.getThreadProjection(ThreadId.make("salted"));
        const stopped = yield* store.getThreadProjection(ThreadId.make("stop"));
        const saltedRun = salted.runs.find((run) => run.id === RunId.make("run-salted"));
        if (reviewCase === "unreadable") {
          const nonCodex = yield* store.getThreadProjection(ThreadId.make("goal"));
          assert.equal(saltedRun?.status, "running");
          assert.equal(nonCodex.runs[0]?.status, "cancelled");
          assert.include(order, "block-thread");
        }
        if (reviewCase === "ordinary" || reviewCase === "ordinary-record")
          assert.equal(saltedRun?.status, "cancelled");
        if (reviewCase === "gone" || reviewCase === "preserve-failure") {
          const continuation = yield* outboxBefore.get(
            "effect:restart-continuation:run-source-salted",
          );
          assert.isFalse(
            Option.isSome(continuation) &&
              ["pending", "running"].includes(continuation.value.status),
          );
          assert.equal(saltedRun?.status, "failed");
          assert.isTrue(
            salted.turnItems.some((item) =>
              JSON.stringify(item).includes(
                "The Codex process stopped while the turn that ran across the restart was still running.",
              ),
            ),
          );
        }
        if (
          reviewCase === "unknown" ||
          reviewCase === "unknown-native" ||
          reviewCase === "missing"
        ) {
          assert.isTrue(
            salted.turnItems.some((item) =>
              JSON.stringify(item).includes(
                "The Codex process for this thread could not be verified.",
              ),
            ),
          );
          if (reviewCase === "unknown") assert.include(order, "record-obligation");
          else assert.include(order, "block-thread");
        }
        if (reviewCase === "stopped") {
          assert.equal(stopped.runs[0]?.status, "interrupted");
          assert.include(order, "clear-obligation");
        }
        if (reviewCase === "stop-completed") {
          assert.equal(stopped.runs[0]?.status, "completed");
          assert.isTrue(
            stopped.turnItems.some(
              (item) =>
                item.type === "run_interrupt_result" &&
                item.message ===
                  "The Codex turn finished before it could be stopped. Work it did while the GOAT server was down is not shown here.",
            ),
          );
        }
        if (reviewCase === "stop-clear-crash") {
          assert.isTrue(pendingStop);
          yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
          assert.isFalse(pendingStop);
        }
        if (reviewCase === "goal-release") {
          yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
          assert.isEmpty(order.filter((item) => item === "read-goal" || item === "clear-goal"));
          assert.deepEqual([oldGoalBlocked, pendingStop, u.status], [true, false, "running"]);
        }
        if (reviewCase === "goal-held")
          assert.isEmpty(order.filter((item) => item === "read-goal" || item === "clear-goal"));
        if (reviewCase === "no-root") {
          const broken = yield* store.getThreadProjection(ThreadId.make("terminal"));
          assert.equal(
            broken.runs.find((run) => run.id === RunId.make("run-terminal"))?.status,
            "running",
          );
          assert.include(order, "block:terminal");
          assert.isTrue(
            broken.turnItems.some((item) => JSON.stringify(item).includes("could not be verified")),
          );
          assert.include(
            (yield* Ref.get(bindings)).map((binding) => binding.threadId),
            ThreadId.make("plain"),
          );
        }
        return;
      }
      assert.deepEqual(
        (yield* Ref.get(bindings)).map((binding) => binding.threadId),
        survival === "off" ? [] : [ThreadId.make("plain"), ThreadId.make("salted")],
      );
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const continuation = yield* outbox.get("effect:restart-continuation:run-plain");
      assert.equal(
        Option.isSome(continuation) &&
          continuation.value.request.type === "provider-runtime.continue",
        survival !== "off",
      );
      const survivor = yield* store.getThreadProjection(ThreadId.make("plain"));
      const goal = yield* store.getThreadProjection(ThreadId.make("goal"));
      const shared = yield* store.getThreadProjection(ThreadId.make("shared"));
      assert.equal(
        survivor.providerTurns[0]?.status,
        survival === "off" ? "interrupted" : "running",
      );
      assert.equal(survivor.attempts[0]?.status, survival === "off" ? "interrupted" : "running");
      assert.equal(goal.providerTurns[0]?.status, "interrupted");
      assert.equal(shared.providerTurns[0]?.status, "interrupted");
      if (survival !== "off") assert.equal(survivor.providerSessions[0]?.status, "ready");
      if (mixed) {
        assert.equal(
          survivor.providerTurns.find((turn) => turn.id === ProviderTurnId.make("turn-plain"))
            ?.status,
          "running",
        );
        assert.equal(
          survivor.attempts.find((attempt) => attempt.id === RunAttemptId.make("attempt-plain"))
            ?.status,
          "running",
        );
        assert.equal(
          survivor.nodes.find((node) => node.id === NodeId.make("node-plain"))?.status,
          "running",
        );
        assert.equal(
          shared.runs.find((run) => run.id === RunId.make("run-shared"))?.status,
          "interrupted",
        );
        const survivorStart = yield* outbox.get("survivor-start");
        const unrelatedStart = yield* outbox.get("unrelated-start");
        const unrelatedCleanup = yield* outbox.get("unrelated-cleanup");
        assert.isTrue(Option.isSome(survivorStart) && survivorStart.value.status === "pending");
        assert.isTrue(Option.isSome(unrelatedStart) && unrelatedStart.value.status === "cancelled");
        assert.isTrue(
          Option.isSome(unrelatedCleanup) && unrelatedCleanup.value.status === "pending",
        );
        assert.equal(
          survivor.runs.find((run) => run.id === RunId.make("run-unrelated"))?.status,
          "cancelled",
        );
        assert.equal(
          survivor.providerTurns.find((turn) => turn.id === ProviderTurnId.make("turn-unrelated"))
            ?.status,
          "cancelled",
        );
        assert.equal(
          survivor.providerTurns.find(
            (turn) => turn.id === ProviderTurnId.make("native-child-turn"),
          )?.status,
          "running",
        );
        assert.equal(
          survivor.nodes.find((node) => node.id === NodeId.make("native-child"))?.status,
          "running",
        );
        assert.equal(
          survivor.subagents.find((agent) => agent.id === NodeId.make("native-child"))?.status,
          "running",
        );
        assert.equal(
          survivor.providerTurns.find((turn) => turn.id === ProviderTurnId.make("stale-turn"))
            ?.status,
          "cancelled",
        );
        assert.equal(
          survivor.runtimeRequests.find(
            (request) => request.id === RuntimeRequestId.make("approval"),
          )?.status,
          "expired",
        );
        assert.equal(
          survivor.runtimeRequests.find(
            (request) => request.id === RuntimeRequestId.make("question"),
          )?.responseCapability.type,
          "message",
        );
      }
      const terminal = yield* store.getThreadProjection(ThreadId.make("terminal"));
      assert.equal(
        terminal.runs.find((run) => run.id === RunId.make("run-terminal"))?.status,
        terminalStatus,
      );
      assert.equal(terminal.attempts[0]?.status, terminalStatus);
      assert.isTrue(Option.isNone(yield* outbox.get("effect:restart-continuation:run-terminal")));
      const cancelledTerminalContinuation = yield* outbox.get(
        "effect:restart-continuation:run-source-terminal",
      );
      assert.isTrue(
        Option.isSome(cancelledTerminalContinuation) &&
          cancelledTerminalContinuation.value.status === "cancelled",
      );
      const stopped = yield* store.getThreadProjection(ThreadId.make("stop"));
      assert.equal(stopped.providerTurns[0]?.status, "interrupted");
      assert.isTrue(stopped.turnItems.some((item) => item.type === "run_interrupt_request"));
      const sql = yield* SqlClient.SqlClient;
      const terminalEvents = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE command_id = ${`command:survivor-terminal:run-terminal:${terminal.providerTurns[0]?.id}`}
      `;
      assert.equal(terminalEvents[0]?.count, 3);
      yield* Ref.set(bindings, []);
      yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      const repeatedTerminalEvents = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE command_id = ${`command:survivor-terminal:run-terminal:${terminal.providerTurns[0]?.id}`}
      `;
      assert.equal(repeatedTerminalEvents[0]?.count, 3);
      assert.deepEqual(
        (yield* Ref.get(bindings)).map((binding) => binding.threadId),
        survival === "off" ? [] : [ThreadId.make("plain"), ThreadId.make("salted")],
      );
      const secondContinuation = yield* outbox.get("effect:restart-continuation:run-plain");
      assert.equal(
        Option.isSome(secondContinuation) && secondContinuation.value.status === "pending",
        survival !== "off",
      );
      assert.isBelow(order.indexOf("load"), order.indexOf("classify:plain"));
      assert.deepEqual(order.slice(order.indexOf("goal-fence"), order.indexOf("goal-fence") + 3), [
        "goal-fence",
        "stop-fence",
        "interrupt",
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);
