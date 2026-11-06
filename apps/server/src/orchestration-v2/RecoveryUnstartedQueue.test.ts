import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect.each([
  "queued",
  "preparing",
  "starting",
  "starting-other-request",
  "starting-own-request",
  "starting-scheduled",
  "starting-delegated",
] as const)("recovers $0 work after restart", (scenario) => {
  const status = scenario.startsWith("starting") ? "starting" : scenario;
  const terminalized =
    status === "preparing" ||
    scenario === "starting-own-request" ||
    scenario === "starting-scheduled" ||
    scenario === "starting-delegated";
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    ...idleThreadProjection(liveThreadShell(threadId)),
    thread: { id: threadId },
    runtimeRequests: scenario.endsWith("request")
      ? [
          {
            id: RuntimeRequestId.make("pending-recovery-request"),
            nodeId:
              scenario === "starting-own-request" ? rootNodeId : NodeId.make("other-run-request"),
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
          },
        ]
      : [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status,
        startedAt: null,
        activeAttemptId: attemptId,
        userMessageId: MessageId.make("message_queued_restart"),
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        ...(status === "preparing"
          ? {
              workspacePreparation: {
                type: "worktree",
                baseRef: "parent-local-commit",
                startFromOrigin: false,
              },
            }
          : {}),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      ...(scenario === "starting-other-request"
        ? [
            {
              id: NodeId.make("other-run-request"),
              runId: RunId.make("earlier-run"),
              status: "waiting",
            },
          ]
        : []),
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages:
      status === "starting"
        ? [
            {
              id: MessageId.make("message_queued_restart"),
              createdBy: "user",
              ...(scenario === "starting-scheduled" ? { scheduledTaskId: "scheduled-task" } : {}),
              ...(scenario === "starting-delegated" ? { delegatedCompletion: {} } : {}),
            },
          ]
        : [],
    turnItems:
      status === "starting"
        ? [
            {
              type: "user_message",
              runId,
              messageId: MessageId.make("message_queued_restart"),
              status: "completed",
            },
          ]
        : [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listNeverAttemptedStarts: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, terminalized ? 1 : 0);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(
      runEvent?.type === "run.updated" ? runEvent.payload.status : null,
      terminalized ? "cancelled" : "queued",
    );
    assert.isEmpty(command.effects);
    if (terminalized) {
      assert.equal(
        attemptEvent?.type === "run-attempt.updated" ? attemptEvent.payload.status : null,
        "cancelled",
      );
      assert.equal(
        nodeEvent?.type === "node.updated" ? nodeEvent.payload.status : null,
        scenario === "starting-own-request" ? null : "cancelled",
      );
    } else {
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : null, 1);
      assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queueHeld : false, true);
      assert.isUndefined(attemptEvent);
      assert.isUndefined(nodeEvent);
      if (status === "starting") {
        const item = command.events.find((event) => event.type === "turn-item.updated");
        assert.equal(item?.type === "turn-item.updated" ? item.payload.status : null, "pending");
      }
    }
  }).pipe(Effect.provide(layer));
});
