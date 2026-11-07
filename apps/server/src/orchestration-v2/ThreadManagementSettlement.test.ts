import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);
it.effect("does not settle after a subsequent user run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:settle-user");
    const threadId = ThreadId.make("thread:settle-user");
    const runId = RunId.make("run:settle-original");
    const nextRunId = RunId.make("run:settle-user");
    const dispatched: string[] = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [
                {
                  id: runId,
                  ordinal: 1,
                  status: "completed",
                  userMessageId: MessageId.make("first"),
                },
                {
                  id: nextRunId,
                  ordinal: 2,
                  status: "completed",
                  userMessageId: MessageId.make("user"),
                },
              ],
              messages: [{ id: MessageId.make("user"), runId: nextRunId, role: "user" }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    yield* service.settleAfterRun({ projectId, threadId, runId });
    expect(dispatched).toEqual([]);
  }),
);

it.effect.each([
  { status: "completed" as const, followUp: "none", settles: true },
  { status: "failed" as const, followUp: "none", settles: false },
  { status: "interrupted" as const, followUp: "none", settles: false },
  { status: "completed" as const, followUp: "notification", settles: true },
  { status: "completed" as const, followUp: "replayed-notification", settles: true },
  { status: "completed" as const, followUp: "delegated", settles: true },
  { status: "completed" as const, followUp: "failed-notification", settles: false },
  { status: "completed" as const, followUp: "held-notification", settles: true },
  { status: "completed" as const, followUp: "user", settles: false },
  { status: "completed" as const, followUp: "steered-notification", settles: false },
])("settleAfterRun handles $status with $followUp follow-up", ({ status, followUp, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const followUpId = RunId.make(`${runId}:follow-up`);
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const replayRejected = yield* Deferred.make<void>();
    let sequence = 0;
    let sequenceReads = 0;
    let rejectedCommandId: CommandId | undefined;
    const runs = [{ id: runId, ordinal: 1, status, userMessageId: MessageId.make("original") }];
    const nextRun = {
      id: followUpId,
      ordinal: 2,
      status: "running" as OrchestrationV2Run["status"],
      userMessageId: MessageId.make("follow-up"),
    };
    const dispatched: Array<string> = [];
    // The notification starts after the completed run was observed, before settlement commits.
    let raced = false;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () =>
            Effect.sync(() => {
              if (followUp === "replayed-notification" && sequenceReads++ === 2) sequence = 1;
              return sequence;
            }),
          restartContinuationPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromQueue(events)),
            ),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: raced ? [...runs, nextRun] : runs,
                  messages: [
                    { id: MessageId.make("original"), runId, role: "user" as const },
                    {
                      id: nextRun.userMessageId,
                      runId: followUpId,
                      role: "user" as const,
                      ...(followUp.endsWith("notification") ? { notification: {} } : {}),
                      ...(followUp === "delegated" ? { delegatedCompletion: {} } : {}),
                    },
                    { id: MessageId.make("reply"), runId: followUpId, role: "assistant" as const },
                    ...(followUp === "steered-notification"
                      ? [
                          {
                            id: MessageId.make("user-steer"),
                            runId: followUpId,
                            role: "user" as const,
                          },
                        ]
                      : []),
                  ].filter(
                    (message) =>
                      (filter?.messageIds === undefined ||
                        filter.messageIds.includes(message.id)) &&
                      (filter?.messageRunIds === undefined ||
                        filter.messageRunIds.includes(message.runId)) &&
                      (filter?.messageRoles === undefined ||
                        filter.messageRoles.includes(message.role)),
                  ),
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (followUp !== "none" && !raced) {
                raced = true;
                rejectedCommandId = command.commandId;
                return yield* new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Thread is still running",
                });
              }
              if (followUp === "replayed-notification" && command.commandId === rejectedCommandId) {
                yield* Deferred.succeed(replayRejected, undefined);
                return yield* new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "Thread is still running",
                });
              }
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .settleAfterRun({ projectId, threadId, runId })
      .pipe(Effect.forkChild);
    if (followUp !== "none") {
      yield* Deferred.await(subscribed);
      expect(dispatched).toEqual([]);
      nextRun.status =
        followUp === "failed-notification"
          ? "failed"
          : followUp === "held-notification"
            ? "queued"
            : "completed";
      yield* Queue.offer(events, {
        sequence: 1,
        event: { type: "run.updated", threadId, payload: nextRun },
      } as unknown as OrchestrationV2StoredEvent);
    }
    if (followUp === "replayed-notification") {
      yield* Deferred.await(replayRejected);
      expect(dispatched).toEqual([]);
      sequence = 2;
      yield* Queue.offer(events, {
        sequence,
        event: { type: "run.updated", threadId, payload: nextRun },
      } as unknown as OrchestrationV2StoredEvent);
    }
    yield* Fiber.join(fiber);
    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);
