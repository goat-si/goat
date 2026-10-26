import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import type { OrchestrationV2ServerCommand } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  ProviderDriverKind,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";

import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          awaitRestartContinuation: () => Effect.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        restartContinuationPending: () => Effect.succeed(false),
        awaitRestartContinuation: () => Effect.never,
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
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
                  turnItems: [],
                  runtimeRequests: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
              turnItems: [],
              runtimeRequests: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
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

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect.each([
  "delegated_task.remote.register",
  "delegated_task.remote.progress",
  "delegated_task.remote.result",
] as const)("hydrates only the parent for %s", (type) =>
  Effect.gen(function* () {
    const parent = ThreadId.make("remote-parent");
    const seen: Array<ThreadId> = [];
    const command =
      type === "delegated_task.remote.register"
        ? {
            type,
            commandId: CommandId.make("register"),
            parentThreadId: parent,
            parentRunId: RunId.make("parent-run"),
            parentNodeId: NodeId.make("parent-root"),
            task: "Inspect",
            modelSelection: {
              instanceId: ProviderInstanceId.make("remote"),
              model: "remote-model",
            },
            driver: ProviderDriverKind.make("claude"),
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            createdBy: "agent" as const,
            creationSource: "mcp" as const,
            remote: { host: "box", threadId: null, correlationId: "rr-A" },
          }
        : type === "delegated_task.remote.progress"
          ? {
              type,
              commandId: CommandId.make("progress"),
              parentThreadId: parent,
              taskId: NodeId.make("task"),
              correlationId: "rr-A",
              remoteThreadId: ThreadId.make("remote-child"),
            }
          : {
              type,
              commandId: CommandId.make("result"),
              parentThreadId: parent,
              taskId: NodeId.make("task"),
              correlationId: "rr-A",
              status: "completed" as const,
              summary: "done",
            };
    const layer = ThreadManagementService.layerWithLegacyImporter.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            awaitRestartContinuation: () => Effect.never,
            dispatch: (received) => {
              expect(received).toEqual(command);
              return Effect.succeed({ sequence: 0, storedEvents: [] });
            },
          }),
          Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
            ensureTranscript: (id) =>
              Effect.sync(() => {
                seen.push(id);
                return { importedThreadCount: 0, importedMessageCount: 0 };
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      yield* service.dispatch(command satisfies OrchestrationV2ServerCommand);
    }).pipe(Effect.provide(layer));
    expect(seen).toEqual([parent]);
  }),
);

it.effect("parent Stop does not traverse a remote delegated task (M11)", () =>
  Effect.gen(function* () {
    const parent = ThreadId.make("remote-stop-parent");
    const projection = idleThreadProjection(liveThreadShell(parent));
    let stops = 0;
    const task = {
      id: NodeId.make("remote-task"),
      threadId: parent,
      runId: RunId.make("parent-run"),
      parentNodeId: NodeId.make("root"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver: ProviderDriverKind.make("claude"),
      providerInstanceId: ProviderInstanceId.make("remote-provider"),
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      remote: { host: "box", threadId: ThreadId.make("remote-child"), correlationId: "rr-A" },
      prompt: "Inspect",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: projection.thread.createdAt,
      completedAt: null,
      updatedAt: projection.thread.updatedAt,
    };
    const stop = ThreadManagementService.makeStopDelegatedTasks({
      getThreadRecords: () => Effect.succeed({ ...projection, subagents: [task] }),
      dispatch: () =>
        Effect.sync(() => {
          stops++;
          return { sequence: 0, storedEvents: [] };
        }),
    });
    yield* stop({ threadId: parent, commandId: CommandId.make("parent-stop") });
    expect(stops).toBe(0);
  }),
);

it("overwrites forged WS response provenance with the user", () => {
  const command: OrchestrationV2Command = {
    type: "runtime-request.respond",
    commandId: CommandId.make("user-response"),
    threadId: ThreadId.make("asking"),
    requestId: RuntimeRequestId.make("question"),
    answers: { q: "  Exact option  " },
    attachmentsByQuestionId: {},
    respondedBy: {
      type: "agent",
      threadId: ThreadId.make("forged"),
      environmentId: null,
      title: "Forged",
      reason: "Forged",
    },
  };
  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({ respondedBy: { type: "user" } });
  if (stamped.type !== "runtime-request.respond") throw new Error("Unexpected command type");
  expect(stamped.answers).toBe(command.answers);
  expect(stamped.attachmentsByQuestionId).toBe(command.attachmentsByQuestionId);
  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "agent",
      creationSource: "mcp",
    }),
  ).toBe(command);
});

it("stamps dismissals as user and clears forged user launchers", () => {
  const dismissed = ThreadManagementService.withCreationProvenance(
    {
      type: "thread.user-input.dismiss",
      commandId: CommandId.make("dismiss"),
      threadId: ThreadId.make("asking"),
      requestId: RuntimeRequestId.make("question"),
      respondedBy: { type: "client", reason: "Forged" },
    },
    { createdBy: "user", creationSource: "mobile" },
  );
  expect(dismissed).toMatchObject({ respondedBy: { type: "user" } });
  const create: OrchestrationV2Command = {
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: ThreadId.make("child"),
    projectId: ProjectId.make("project"),
    title: "Child",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "mcp",
    launchedBy: {
      kind: "launch" as const,
      environmentLabel: null,
      threadTitle: null,
      threadId: ThreadId.make("forged"),
      environmentId: null,
      via: "thread_launch",
    },
  };
  expect(
    ThreadManagementService.withCreationProvenance(create, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).not.toHaveProperty("launchedBy");
  expect(
    ThreadManagementService.withCreationProvenance(create, {
      createdBy: "agent",
      creationSource: "mcp",
    }),
  ).toMatchObject({ launchedBy: create.launchedBy });
});

it.effect.each([
  { status: "running" as const, mode: "live" as const },
  { status: "completed" as const, mode: "message" as const },
])("waitForThread returns a $mode question at entry on a $status run", ({ status, mode }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("question-project");
    const threadId = ThreadId.make("question-thread");
    const runId = RunId.make("question-run");
    const requestId = RuntimeRequestId.make("question-request");
    const projection = {
      thread: { id: threadId, projectId, deletedAt: null },
      runs: [{ id: runId, status }],
      turnItems: [
        { type: "user_input_request", runId, requestId },
        { type: "user_input_request", runId: "other-run", requestId: "other" },
      ],
      runtimeRequests: [
        {
          id: requestId,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: mode },
        },
        { id: "other", kind: "user_input", status: "pending" },
        { id: "approval", kind: "command", status: "pending" },
        { id: "orphan", kind: "user_input", status: "pending" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const filters: Array<unknown> = [];
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          awaitRestartContinuation: () => Effect.never,
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadRecords: (_id, _fields, filter) => {
            filters.push(filter);
            return Effect.succeed(projection);
          },
          streamStoredEventsFrom: () => Stream.die("Should return at entry"),
        }),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layer),
    );
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 1000 }),
    ).toMatchObject({ pendingRequestIds: [requestId], timedOut: false, run: { status } });
    expect(filters).toContainEqual({
      turnItemTypes: ["user_input_request"],
      turnItemRunIds: [runId],
    });
    expect(filters).toContainEqual({ runtimeRequestIds: [requestId] });
  }),
);

it.effect.each([false, true])(
  "waitForThread releases on a persisted question, replay=%s",
  (replay) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("event-project");
      const threadId = ThreadId.make("event-thread");
      const runId = RunId.make("event-run");
      const requestId = RuntimeRequestId.make("event-question");
      const subscribed = yield* Deferred.make<void>();
      const ignoredRead = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let pending = false;
      let selected = false;
      const projection = () =>
        ({
          thread: { id: threadId, projectId, deletedAt: null },
          runs: [{ id: runId, status: "running" }],
          runtimeRequests: pending
            ? [{ id: requestId, kind: "user_input", status: "pending" }]
            : [],
          turnItems: pending
            ? [{ type: "user_input_request", runId: selected ? runId : "other-run", requestId }]
            : [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const event = {
        sequence: 8,
        event: { type: "runtime-request.updated", threadId },
      } as unknown as OrchestrationV2StoredEvent;
      const layer = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            awaitRestartContinuation: () => Effect.never,
            getThreadEventSequence: () => Effect.succeed(7),
            getThreadRecords: (_id, fields) =>
              Effect.gen(function* () {
                const result = projection();
                if (pending && !selected && fields.some((field) => field === "turnItems"))
                  yield* Deferred.succeed(ignoredRead, undefined);
                return result;
              }),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "runtime-request.updated"
                ? Stream.unwrap(
                    Effect.gen(function* () {
                      expect(input.afterSequence).toBe(7);
                      yield* Deferred.succeed(subscribed, undefined);
                      if (replay) {
                        pending = true;
                        selected = true;
                        return Stream.make(event);
                      }
                      return Stream.fromQueue(events);
                    }),
                  )
                : Stream.never,
          }),
        ),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layer),
      );
      const fiber = yield* service
        .waitForThread({ projectId, threadId, runId, timeoutMs: 1000 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      if (!replay) {
        pending = true;
        yield* Queue.offer(events, event);
        yield* Deferred.await(ignoredRead);
        expect(fiber.pollUnsafe()).toBeUndefined();
        selected = true;
        yield* Queue.offer(events, { ...event, sequence: 9 });
      }
      expect(yield* Fiber.join(fiber)).toMatchObject({
        timedOut: false,
        pendingRequestIds: [requestId],
        run: { status: "running" },
      });
    }),
);

it.effect.each(["question", "terminal"] as const)(
  "waitForThread skips forwarded questions and releases on %s",
  (release) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("ignored-project");
      const threadId = ThreadId.make("ignored-thread");
      const runId = RunId.make("ignored-run");
      const ignored = RuntimeRequestId.make("forwarded");
      const fresh = RuntimeRequestId.make("fresh");
      const subscribed = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const reread = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let status = "running";
      let requestIds = [ignored];
      let itemReads = 0;
      const layer = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            awaitRestartContinuation: () => Effect.never,
            getThreadEventSequence: () => Effect.succeed(7),
            getThreadRecords: (_id, fields) =>
              Effect.gen(function* () {
                const projection = {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [{ id: runId, status }],
                  turnItems: requestIds.map((requestId) => ({
                    type: "user_input_request",
                    runId,
                    requestId,
                  })),
                  runtimeRequests: requestIds.map((id) => ({
                    id,
                    kind: "user_input",
                    status: "pending",
                  })),
                } as unknown as OrchestrationV2ThreadProjection;
                if (fields.some((field) => field === "turnItems") && ++itemReads > 1)
                  yield* Deferred.succeed(reread, undefined);
                return projection;
              }),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "runtime-request.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
          }),
        ),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layer),
      );
      const fiber = yield* service
        .waitForThread({ projectId, threadId, runId, timeoutMs: 1000, ignoreRequestIds: [ignored] })
        .pipe(
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.forkChild,
        );
      expect(
        yield* Effect.raceFirst(
          Deferred.await(subscribed).pipe(Effect.as(true)),
          Deferred.await(finished).pipe(Effect.as(false)),
        ),
      ).toBe(true);
      expect(fiber.pollUnsafe()).toBeUndefined();
      const event = {
        sequence: 8,
        event: { type: "runtime-request.updated", threadId },
      } as unknown as OrchestrationV2StoredEvent;
      yield* Queue.offer(events, event);
      yield* Deferred.await(reread);
      expect(fiber.pollUnsafe()).toBeUndefined();
      if (release === "question") requestIds = [ignored, fresh];
      else status = "completed";
      yield* Queue.offer(events, { ...event, sequence: 9 });
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        timedOut: false,
        run: { status: release === "question" ? "running" : "completed" },
      });
      expect(result.pendingRequestIds).toEqual(release === "question" ? [fresh] : undefined);
    }),
);

it.effect("waitForThread final timeout read prefers a pending question over timeout", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("timeout-project");
    const threadId = ThreadId.make("timeout-thread");
    const runId = RunId.make("timeout-run");
    const requestId = RuntimeRequestId.make("timeout-question");
    const subscribed = yield* Deferred.make<void>();
    let pending = false;
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          awaitRestartContinuation: () => Effect.never,
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "running" }],
              turnItems: pending ? [{ type: "user_input_request", runId, requestId }] : [],
              runtimeRequests: pending
                ? [{ id: requestId, kind: "user_input", status: "pending" }]
                : [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layer),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 1 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = true;
    yield* TestClock.adjust(Duration.millis(1));
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: false,
      pendingRequestIds: [requestId],
    });
  }),
);

it.effect("settleAfterRun waits through a question and settles on completion", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("settle-project");
    const threadId = ThreadId.make("settle-thread");
    const runId = RunId.make("settle-run");
    const subscribed = yield* Deferred.make<void>();
    const reread = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let reads = 0;
    const commands: Array<string> = [];
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          awaitRestartContinuation: () => Effect.never,
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadRecords: () =>
            Effect.gen(function* () {
              if (++reads > 1) yield* Deferred.succeed(reread, undefined);
              return {
                thread: { id: threadId, projectId, deletedAt: null },
                runs: [{ id: runId, status }],
                turnItems: [{ type: "user_input_request", runId, requestId: "q" }],
                runtimeRequests: [{ id: "q", kind: "user_input", status: "pending" }],
              } as unknown as OrchestrationV2ThreadProjection;
            }),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "runtime-request.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command.type);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layer),
    );
    const fiber = yield* service
      .settleAfterRun({ projectId, threadId, runId })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* Queue.offer(events, {
      event: { type: "runtime-request.updated", threadId },
    } as unknown as OrchestrationV2StoredEvent);
    yield* Deferred.await(reread);
    expect(commands).toEqual([]);
    status = "completed";
    yield* Queue.offer(events, {
      event: { type: "runtime-request.updated", threadId },
    } as unknown as OrchestrationV2StoredEvent);
    yield* Fiber.join(fiber);
    expect(commands).toEqual(["thread.settle"]);
  }),
);

it.effect.each([
  {
    role: "review",
    status: "running",
    createdBy: "agent",
    mode: "steer_when_ready",
    refused: false,
  },
  ...["steer_when_ready", "queue", "restart"].map((mode) => ({
    role: "review",
    status: "running",
    createdBy: "agent",
    mode,
    refused: false,
    retryAfterCompletion: true,
  })),
  {
    role: "review",
    status: "completed",
    createdBy: "agent",
    mode: "steer_when_ready",
    refused: false,
    followup: "running",
  },
  {
    role: "review",
    status: "completed",
    createdBy: "agent",
    mode: "queue",
    refused: false,
    followup: "completed_general",
  },
  ...["completed", "failed", "cancelled", "interrupted"].flatMap((status) =>
    ["steer_when_ready", "queue", "restart"].map((mode) => ({
      role: "review",
      status,
      createdBy: "agent",
      mode,
      refused: true,
    })),
  ),
  ...["implementation", "research", "design", "test", "general", undefined].map((role) => ({
    role,
    status: "completed",
    createdBy: "agent",
    mode: "queue",
    refused: false,
  })),
  { role: "review", status: "completed", createdBy: "user", mode: "queue", refused: false },
] as const)("review send policy: $role/$status/$createdBy/$mode", (scenario) =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("review-parent");
    const childId = ThreadId.make("review-child");
    const messageId = MessageId.make("review-followup");
    const runId = RunId.make("review-run");
    const child = idleThreadProjection(liveThreadShell(childId));
    const parent = idleThreadProjection(liveThreadShell(parentId));
    const projection = {
      ...child,
      thread: {
        ...child.thread,
        lineage: {
          ...child.thread.lineage,
          parentThreadId: parentId,
          relationshipToParent: "subagent",
        },
      },
      runs: [
        {
          id: runId,
          status:
            scenario.status === "running" ||
            ("followup" in scenario && scenario.followup === "running")
              ? "running"
              : "completed",
          ordinal: 1,
          activeAttemptId: "attempt",
          providerThreadId: "provider-thread",
          userMessageId: null,
        },
      ],
      providerTurns: [{ status: "running", runAttemptId: "attempt" }],
      providerThreads: [{ id: "provider-thread", providerSessionId: "session" }],
      providerSessions: [
        { id: "session", capabilities: { turns: { supportsActiveSteering: true } } },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    let parentProjection = {
      ...parent,
      subagents: [
        {
          id: NodeId.make("review-task"),
          origin: "app_owned",
          childThreadId: childId,
          role: scenario.role,
          status: scenario.status,
        },
        ...("followup" in scenario
          ? [
              {
                id: NodeId.make("followup-task"),
                origin: "app_owned",
                childThreadId: childId,
                role: scenario.followup === "running" ? "review" : "general",
                status: scenario.followup === "running" ? "running" : "completed",
              },
            ]
          : []),
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerReceiptsTest),
          Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (id, _fields, filter) =>
                Effect.succeed(
                  id === parentId
                    ? parentProjection
                    : {
                        ...projection,
                        // Intake reads interrupt requests separately from the delivery item.
                        turnItems: filter?.turnItemTypes?.includes("run_interrupt_request")
                          ? []
                          : projection.turnItems,
                      },
                ),
              getThreadEventSequence: () => Effect.succeed(0),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  if (command.type !== "message.dispatch")
                    throw new Error("Expected message dispatch");
                  (projection as unknown as { messages: unknown[] }).messages = [
                    { id: messageId, runId },
                  ];
                  (projection as unknown as { turnItems: unknown[] }).turnItems = [
                    {
                      type: "user_message",
                      messageId,
                      inputIntent:
                        command.dispatchMode.type === "steer_active" ? "steer" : "queued_turn",
                    },
                  ];
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          ),
        ),
      ),
    );
    const send = {
      projectId: child.thread.projectId,
      commandId: CommandId.make("review-send"),
      threadId: childId,
      // Even an agent other than the parent must obey the review's lifecycle.
      senderThreadId: ThreadId.make("another-agent"),
      messageId,
      text: "Review again",
      attachments: [],
      mode: scenario.mode as ThreadManagementService.ThreadManagementSendMode,
      createdBy: scenario.createdBy === "user" ? "user" : "agent",
      creationSource: scenario.createdBy === "user" ? "web" : "mcp",
    } satisfies ThreadManagementService.ThreadManagementSendInput;
    const result = yield* service.sendToThread(send).pipe(Effect.result);
    if ("retryAfterCompletion" in scenario && result._tag === "Success") {
      parentProjection = {
        ...parentProjection,
        subagents: parentProjection.subagents.map((task) => ({ ...task, status: "completed" })),
      };
      const replay = yield* service.sendToThread(send);
      expect(replay.message.id).toBe(result.success.message.id);
      expect(replay.run.id).toBe(result.success.run.id);
      expect(replay.delivery).toBe(result.success.delivery);
      expect(dispatched).toHaveLength(1);
    }
    if (scenario.refused) {
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure).toBeInstanceOf(
        ThreadManagementService.ThreadManagementReviewTaskFinishedError,
      );
      expect(result.failure.message).toContain("goat_task_create");
      expect(dispatched).toHaveLength(0);
    } else {
      expect(result._tag).toBe("Success");
      expect(dispatched).toHaveLength(1);
      if (scenario.mode === "steer_when_ready" && result._tag === "Success")
        expect(result.success.delivery).toBe("steered");
    }
  }),
);

it.effect.each(["running", "completed"] as const)(
  "checks the persisted remote review owner when %s",
  (status) =>
    Effect.gen(function* () {
      const originId = ThreadId.make("remote-review-owner");
      const remoteId = ThreadId.make("remote-review-child");
      const parent = idleThreadProjection(liveThreadShell(originId));
      let records = {
        ...parent,
        subagents: [
          {
            origin: "app_owned",
            role: "review",
            status,
            remote: { host: "box", threadId: remoteId },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(layerReceiptsTest),
            Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: (id) => {
                  expect(id).toBe(originId);
                  return Effect.succeed(records);
                },
              }),
            ),
          ),
        ),
      );
      const input = {
        senderThreadId: originId,
        threadId: remoteId,
        host: "box",
        createdBy: "agent" as const,
      };
      const result = yield* service.assertReviewTaskSendAllowed(input).pipe(Effect.result);
      expect(result._tag).toBe(status === "running" ? "Success" : "Failure");
      if (result._tag === "Failure")
        expect(result.failure).toBeInstanceOf(
          ThreadManagementService.ThreadManagementReviewTaskFinishedError,
        );
      yield* service.assertReviewTaskSendAllowed({ ...input, host: "another-box" });
      yield* service.assertReviewTaskSendAllowed({ ...input, createdBy: "user" });
      if (status === "completed") {
        records = {
          ...records,
          subagents: [...records.subagents, { ...records.subagents[0]!, status: "running" }],
        };
        yield* service.assertReviewTaskSendAllowed(input);
        records = {
          ...records,
          subagents: [
            records.subagents[0]!,
            { ...records.subagents[1]!, status: "completed", role: "general" },
          ],
        };
        yield* service.assertReviewTaskSendAllowed(input);
      }
    }),
);

it.effect.each([
  { sender: "channel-worker:abc", computerUse: true, expected: "queue_after_active" },
  { sender: "peer", computerUse: true, expected: "steer_active" },
  // No turn holds a driver while computer use is off, so nothing changes.
  { sender: "channel-worker:abc", computerUse: false, expected: "steer_active" },
] as const)(
  "queues a steer from an unattended sender behind a person's turn ($sender, computer use $computerUse)",
  ({ sender, computerUse, expected }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("mine");
      const runId = RunId.make("typed");
      const messageId = MessageId.make("from-sender");
      const base = idleThreadProjection(liveThreadShell(threadId));
      const projection = {
        ...base,
        runs: [
          {
            id: runId,
            status: "running",
            ordinal: 1,
            activeAttemptId: "attempt",
            providerThreadId: "provider-thread",
            userMessageId: "typed-message",
            requestedAt: DateTime.makeUnsafe(0),
            completedAt: null,
          },
        ],
        messages: [{ id: "typed-message", createdAt: DateTime.makeUnsafe(0), createdBy: "user" }],
        providerTurns: [{ status: "running", runAttemptId: "attempt" }],
        providerThreads: [{ id: "provider-thread", providerSessionId: "session" }],
        providerSessions: [
          { id: "session", capabilities: { turns: { supportsActiveSteering: true } } },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const peer = idleThreadProjection(liveThreadShell(ThreadId.make("peer")));
      const dispatched: OrchestrationV2ServerCommand[] = [];
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(layerReceiptsTest),
            Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
            Layer.provide(
              Layer.mock(CuaDriver.CuaDriver)({ enabled: Effect.succeed(computerUse) }),
            ),
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: (id) => Effect.succeed(id === "peer" ? peer : projection),
                getThreadEventSequence: () => Effect.succeed(0),
                dispatch: (command) =>
                  Effect.sync(() => {
                    dispatched.push(command);
                    if (command.type !== "message.dispatch") throw new Error("Expected a message");
                    const queued = command.dispatchMode.type === "queue_after_active";
                    (projection as unknown as { messages: unknown[] }).messages = [
                      { id: messageId, runId: queued ? "queued-run" : runId },
                    ];
                    (projection as unknown as { runs: unknown[] }).runs = [
                      ...projection.runs.filter((item) => item.id === runId),
                      ...(queued ? [{ id: "queued-run", status: "queued", ordinal: 2 }] : []),
                    ];
                    (projection as unknown as { turnItems: unknown[] }).turnItems = queued
                      ? []
                      : [{ type: "user_message", messageId, inputIntent: "steer" }];
                    return { sequence: 1, storedEvents: [] };
                  }),
              }),
            ),
          ),
        ),
      );
      yield* service.sendToThread({
        projectId: base.thread.projectId,
        commandId: CommandId.make("send-" + sender),
        threadId,
        senderThreadId: ThreadId.make(sender),
        messageId,
        text: "Use the screen to check the build",
        attachments: [],
        mode: "steer",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const command = dispatched[0];
      expect(command?.type === "message.dispatch" ? command.dispatchMode : undefined).toEqual(
        expected === "queue_after_active"
          ? { type: "queue_after_active", behindRunId: runId }
          : { type: "steer_active", targetRunId: runId },
      );
    }),
);
