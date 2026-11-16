import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const serviceOver = (orchestrator: Partial<Orchestrator.OrchestratorV2["Service"]>) =>
  ThreadManagementService.ThreadManagementService.pipe(
    Effect.provide(
      ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)(orchestrator)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      ),
    ),
  );

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const service = yield* serviceOver({
      getThreadEventSequence: () => Effect.succeed(0),
      restartContinuationPending: () => Effect.succeed(false),
      delegatedTaskResultPending: () => Effect.succeed(false),
      streamStoredEventsFrom: (input) =>
        input?.eventType === "subagent.updated"
          ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromQueue(events)),
            )
          : Stream.never,
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: { id: threadId, projectId, deletedAt: null },
              runs,
              messages: [],
              subagents,
              providerThreads: [],
              turnItems: [],
              runtimeRequests: [],
            }) as unknown as OrchestrationV2ThreadProjection,
        ),
    });
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const service = yield* serviceOver({
      getThreadEventSequence: () => Effect.succeed(0),
      restartContinuationPending: () => Effect.succeed(false),
      delegatedTaskResultPending: () => Effect.succeed(false),
      streamStoredEventsFrom: () => Stream.never,
      getThreadRecords: () =>
        Effect.succeed({
          thread: { id: threadId, projectId, deletedAt: null },
          runs: [rolledBack],
          messages: [],
          subagents: [],
          providerThreads: [],
          turnItems: [],
          runtimeRequests: [],
        } as unknown as OrchestrationV2ThreadProjection),
    });
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread for delegated work times out while a delegated task still runs", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-still-delegating");
    const threadId = ThreadId.make("thread:thread-management:wait-still-delegating");
    const runId = RunId.make("run:thread-management:wait-still-delegating");
    const ended = {
      id: runId,
      ordinal: 1,
      status: "completed",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const service = yield* serviceOver({
      getThreadEventSequence: () => Effect.succeed(0),
      restartContinuationPending: () => Effect.succeed(false),
      delegatedTaskResultPending: () => Effect.succeed(false),
      streamStoredEventsFrom: () => Stream.never,
      getThreadRecords: () =>
        Effect.succeed({
          thread: { id: threadId, projectId, deletedAt: null },
          runs: [ended],
          messages: [],
          subagents: [{ status: "running" }],
          providerThreads: [],
          turnItems: [],
          runtimeRequests: [],
        } as unknown as OrchestrationV2ThreadProjection),
    });
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    // The run ended, but the work it is waiting on did not, so this is a timeout with no answer.
    expect(result).toMatchObject({ timedOut: true, run: { id: runId, status: "completed" } });
    expect(result).not.toHaveProperty("resultRun");
  }),
);

it.effect("waitForThread for delegated work releases on a question a later run asks", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-later-question");
    const threadId = ThreadId.make("thread:thread-management:wait-later-question");
    const runId = RunId.make("run:thread-management:wait-later-question");
    const wakeRunId = RunId.make("run:thread-management:wait-later-question:wake");
    const question = RuntimeRequestId.make("request:later-question");
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"]) =>
      ({
        id,
        ordinal,
        status,
        startedAt: DateTime.makeUnsafe(ordinal * 1_000),
        completedAt: status === "running" ? null : DateTime.makeUnsafe(ordinal * 1_000 + 500),
      }) as unknown as OrchestrationV2Run;
    // The run ended; the run its background work woke now waits on the user.
    const service = yield* serviceOver({
      getThreadEventSequence: () => Effect.succeed(0),
      restartContinuationPending: () => Effect.succeed(false),
      delegatedTaskResultPending: () => Effect.succeed(false),
      streamStoredEventsFrom: () => Stream.never,
      getThreadRecords: () =>
        Effect.succeed({
          thread: { id: threadId, projectId, deletedAt: null },
          runs: [run(runId, 1, "completed"), run(wakeRunId, 2, "running")],
          messages: [],
          subagents: [],
          providerThreads: [],
          turnItems: [{ type: "user_input_request", runId: wakeRunId, requestId: question }],
          runtimeRequests: [{ id: question, kind: "user_input", status: "pending" }],
        } as unknown as OrchestrationV2ThreadProjection),
    });
    const wait = (options: {
      readonly untilDelegatedWorkSettled?: boolean;
      readonly releaseOnPendingQuestion?: boolean;
      readonly ignoreRequestIds?: ReadonlyArray<RuntimeRequestId>;
    }) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .waitForThread({ projectId, threadId, runId, timeoutMs: 60_000, ...options })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(60_000));
        return yield* Fiber.join(fiber);
      });

    expect(yield* wait({ untilDelegatedWorkSettled: true })).toMatchObject({
      timedOut: false,
      pendingRequestIds: [question],
    });
    // Internal settling and a forwarded question still wait for the work.
    const held = { timedOut: true };
    expect(
      yield* wait({ untilDelegatedWorkSettled: true, releaseOnPendingQuestion: false }),
    ).toMatchObject(held);
    expect(
      yield* wait({ untilDelegatedWorkSettled: true, ignoreRequestIds: [question] }),
    ).toMatchObject(held);
    // Without the field the ended run answers at once, as before.
    const plain = yield* wait({});
    expect(plain).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(plain).not.toHaveProperty("pendingRequestIds");
  }),
);
