import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadSettlementAfterRun from "./ThreadSettlementAfterRun.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "queued-automatic-settlement" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

it.effect.each(["notification", "delegated", "held", "manual"] as const)(
  "handles queued %s follow-ups when settling",
  (kind) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`thread:settle-queued:${kind}`);
      const projectId = ProjectId.make("project:settle-queued");
      const originalId = RunId.make(`run:original:${kind}`);
      const followId = RunId.make(`run:follow:${kind}`);
      const messageId = MessageId.make(`message:follow:${kind}`);
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${kind}`),
        threadId,
        projectId,
        title: "Queued follow-up",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const base = {
        threadId,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        rootNodeId: null,
        activeAttemptId: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const original = {
        ...base,
        id: originalId,
        ordinal: 1,
        userMessageId: MessageId.make(`message:original:${kind}`),
        status: "completed" as const,
      };
      const follow = {
        ...base,
        id: followId,
        ordinal: 2,
        userMessageId: messageId,
        status: "queued" as const,
        queueHeld: kind === "held",
        startedAt: null,
        completedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(`original:${kind}`),
            type: "run.created",
            threadId,
            runId: originalId,
            occurredAt: now,
            payload: original,
          },
          {
            id: EventId.make(`message:${kind}`),
            type: "message.updated",
            threadId,
            runId: followId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId: followId,
              nodeId: null,
              role: "user",
              createdBy: "agent",
              creationSource: "server",
              text: "Automatic follow-up",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              ...(kind !== "delegated"
                ? {
                    notification: {
                      source: { kind: "monitor" as const },
                      outcome: "updated" as const,
                      summary: "Update",
                    },
                  }
                : {
                    delegatedCompletion: {
                      parentRunId: originalId,
                      generation: 1,
                      taskIds: [NodeId.make("task:one")],
                    },
                  }),
            },
          },
          {
            id: EventId.make(`follow:${kind}`),
            type: "run.created",
            threadId,
            runId: followId,
            occurredAt: now,
            payload: follow,
          },
        ],
      });
      expect(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === followId)
          ?.status,
      ).toBe("queued");
      if (kind === "held" || kind === "manual") {
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:${kind}`),
          threadId,
          ...(kind === "held" ? { expectedLatestRunId: followId } : {}),
        });
        const settled = yield* orchestrator.getThreadProjection(threadId);
        expect(settled.thread.settledAt).not.toBeNull();
        expect(settled.runs.find((run) => run.id === followId)?.status).toBe("cancelled");
        return;
      }
      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:guard:${kind}`),
          threadId,
          expectedLatestRunId: followId,
        })
        .pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestratorDispatchError");
      expect(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === followId)
          ?.status,
      ).toBe("queued");
      const subscribed = yield* Deferred.make<void>();
      const runningHandled = yield* Deferred.make<void>();
      const attempts = yield* Queue.unbounded<string>();
      const marker = EventId.make(`running-confirmed:${kind}`);
      const observingOrchestrator = {
        ...orchestrator,
        streamStoredEventsFrom: (
          input: Parameters<typeof orchestrator.streamStoredEventsFrom>[0],
        ) =>
          Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(
              orchestrator
                .streamStoredEventsFrom(input)
                .pipe(
                  Stream.tap((stored) =>
                    stored.event.id === marker
                      ? Deferred.succeed(runningHandled, undefined)
                      : Effect.void,
                  ),
                ),
            ),
          ),
      };
      const fiber = yield* ThreadSettlementAfterRun.settleAfterRun({
        projectId,
        threadId,
        run: original,
        timeoutMs: 86_400_000,
        orchestrator: observingOrchestrator,
        records: (input, fields, filter) =>
          orchestrator.getThreadRecords(input.threadId, fields, filter).pipe(Effect.orDie),
        dispatch: (command) =>
          Queue.offer(attempts, command.type).pipe(
            Effect.andThen(orchestrator.dispatch(command)),
            Effect.orDie,
          ),
      }).pipe(Effect.forkScoped);
      yield* Effect.raceFirst(
        Deferred.await(subscribed),
        Fiber.await(fiber).pipe(Effect.andThen(Effect.die("settled before the queued follow-up"))),
      );
      expect(yield* Queue.size(attempts)).toBe(0);
      yield* sink.write({
        events: [
          {
            id: EventId.make(`running:${kind}`),
            type: "run.updated",
            threadId,
            runId: followId,
            occurredAt: now,
            payload: { ...follow, status: "running", startedAt: now },
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            id: marker,
            type: "run.updated",
            threadId,
            runId: followId,
            occurredAt: now,
            payload: { ...follow, status: "running", startedAt: now },
          },
        ],
      });
      yield* Effect.raceFirst(
        Deferred.await(runningHandled),
        Fiber.await(fiber).pipe(
          Effect.andThen(Effect.die("settled before the follow-up completed")),
        ),
      );
      expect(yield* Queue.size(attempts)).toBe(0);
      const whileRunning = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:running:${kind}`),
          threadId,
          expectedLatestRunId: followId,
        })
        .pipe(Effect.flip);
      expect(whileRunning._tag).toBe("OrchestratorDispatchError");
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.settledAt).toBeNull();
      yield* sink.write({
        events: [
          {
            id: EventId.make(`completed:${kind}`),
            type: "run.updated",
            threadId,
            runId: followId,
            occurredAt: now,
            payload: { ...follow, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(fiber);
      expect(yield* Queue.takeAll(attempts)).toEqual(["thread.settle"]);
      const settled = yield* orchestrator.getThreadProjection(threadId);
      expect(settled.thread.settledAt).not.toBeNull();
      expect(settled.runs.find((run) => run.id === followId)?.status).toBe("completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);
