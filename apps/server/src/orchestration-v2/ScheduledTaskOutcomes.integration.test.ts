import * as Console from "effect/Console";
import * as TestClock from "effect/testing/TestClock";
import { RunId } from "@goat/contracts";
import * as Tracer from "effect/Tracer";
import * as Schema from "effect/Schema";
import { ScheduledTaskRun } from "@goat/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2OpenSessionInput,
} from "@goat/provider-core/server/ProviderAdapter";
import {
  CommandId,
  EventId,
  MessageId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type ScheduledTaskUpsertInput,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Runs from "../scheduledTasks/ScheduledTaskRuns.ts";
import {
  layerSink,
  requestFor,
  syntheticLaunch,
  waitForSpan,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import { projectId, modelSelection } from "./testkit/threadLaunchInput.ts";
import * as Launch from "./ThreadLaunchService.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerProjectServiceTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  seedProject,
} from "./runtimeLayer.testkit.ts";

const harness = () => {
  const launch = Layer.unwrap(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      return Layer.mock(Launch.ThreadLaunchService)({
        launch: (input) =>
          syntheticLaunch(sink)(input, "queued").pipe(
            Effect.mapError(
              (cause) =>
                new Launch.ThreadLaunchError({
                  operation: "dispatch-message",
                  commandId: input.commandId!,
                  projectId: input.projectId,
                  cause,
                }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(layerSink));
  const dependencies = Layer.mergeAll(
    launch,
    Layer.mock(Threads.ThreadManagementService)({}),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(Secrets.SecretRequests)({}),
    NodeCrypto.layer,
    Scheduler.layer,
  );
  return Layer.mergeAll(Tasks.layer.pipe(Layer.provide(dependencies)), layerSink, Runs.layer).pipe(
    Layer.provideMerge(Sqlite.layerMemory),
  );
};
const create = Effect.fn("ScheduledOutcomesTest.create")(function* (
  overrides: Partial<ScheduledTaskUpsertInput> = {},
) {
  const tasks = yield* Tasks.ScheduledTaskService;
  return (yield* tasks.upsert({
    id: ScheduledTaskId.make("task"),
    title: "Synthetic",
    prompt: "Synthetic",
    enabled: false,
    schedule: { type: "interval", everyMs: 60000 },
    projectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    ...overrides,
  })).task;
});
const update = Effect.fn("ScheduledOutcomesTest.update")(function* (
  run: OrchestrationV2Run,
  status: OrchestrationV2Run["status"],
  suffix = status,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  return yield* sink.write({
    events: [
      {
        id: EventId.make(`terminal:${suffix}`),
        threadId: run.threadId,
        occurredAt: now,
        type: "run.updated",
        payload: {
          ...run,
          status,
          completedAt: now,
          terminationCause: { kind: status === "interrupted" ? "person_stop" : "unknown" },
        },
      },
    ],
  });
});

const worktreeAutomationHarness = () => {
  const providerCwds: Array<string | null> = [];
  const threadId = ThreadId.make("automation-preparation-interrupted");
  const providers = Layer.effect(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    Effect.gen(function* () {
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const instance = yield* registry.getInstance(modelSelection.instanceId);
      if (instance === undefined) return yield* Effect.die("Missing fixture provider.");
      const observed = {
        ...instance,
        orchestrationAdapter: {
          ...instance.orchestrationAdapter,
          openSession: Effect.fn("ScheduledOutcomesTest.observeProviderStart")(function* (
            request: ProviderAdapterV2OpenSessionInput,
          ) {
            providerCwds.push(request.runtimePolicy.cwd);
            return yield* new ProviderAdapterOpenSessionError({
              driver: instance.driverKind,
              providerSessionId: request.providerSessionId,
            });
          }),
        },
      } satisfies typeof instance;
      return {
        ...registry,
        getInstance: (id) =>
          id === observed.instanceId ? Effect.succeed(observed) : registry.getInstance(id),
      };
    }),
  ).pipe(Layer.provide(layerTestProviderInstanceRegistry));
  const runtime = Layer.mergeAll(RuntimeLayer.layer, ProjectStore.layer, Projections.layer).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(providers),
    Layer.provide(ModelManifest.layerTest),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerProjectServiceTest),
    Layer.provide(layerPlatformTest),
  );
  const launch = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(Launch.ThreadLaunchService)({
        launch: Effect.fn("ScheduledOutcomesTest.acceptBeforeWorkspacePreparation")(function* (
          input: Launch.ThreadLaunchInput,
        ) {
          const initial = input.initialMessage;
          if (initial?.messageId === undefined)
            return yield* Effect.die("Missing scheduled message id.");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("automation-create"),
            threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          const accepted = yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("automation-initial-message"),
            threadId,
            ...initial,
            messageId: initial.messageId,
            dispatchMode: { type: "defer_start", workspaceStrategy: input.workspaceStrategy },
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          return {
            threadId,
            projection: yield* orchestrator.getThreadProjection(threadId),
            resumed: false,
            sequence: accepted.sequence,
          };
        }, Effect.orDie),
      });
    }),
  );
  const tasksLayer = Tasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        launch,
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(Secrets.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  const prepareInterruptedAutomation = Effect.fn(
    "ScheduledOutcomesTest.prepareInterruptedAutomation",
  )(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
    const fs = yield* FileSystem.FileSystem;
    const projectCheckout = yield* fs.makeTempDirectoryScoped({ prefix: "automation-project-" });
    yield* seedProject({
      projectId,
      title: "Automation project",
      workspaceRoot: projectCheckout,
      defaultModelSelection: modelSelection,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    const taskId = yield* Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const task = yield* create({
        threadMode: "continue",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      const first = yield* tasks.runNow({ id: task.id });
      assert.equal(first.task.threadId, threadId);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
        "preparing",
      );
      return task.id;
    }).pipe(Effect.provide(tasksLayer));
    yield* recovery.reconcile("startup");
    const recovered = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(recovered.thread.worktreePath);
    assert.deepInclude(recovered.runs[0], {
      status: "cancelled",
      terminationCause: { kind: "server_restart" },
      workspacePreparation: { type: "worktree", baseRef: "main" },
    });
    return taskId;
  });
  return {
    layer: Layer.merge(runtime, NodeServices.layer),
    tasksLayer,
    prepareInterruptedAutomation,
    threadId,
    providerCwds,
  };
};

it.effect("a restarted worktree automation never opens a provider in the project checkout", () => {
  const { layer, tasksLayer, prepareInterruptedAutomation, threadId, providerCwds } =
    worktreeAutomationHarness();
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const taskId = yield* prepareInterruptedAutomation();
    yield* TestClock.adjust("1 second");
    const second = yield* Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      return yield* tasks.runNow({ id: taskId });
    }).pipe(Effect.provide(Layer.fresh(tasksLayer)));
    yield* worker.drain();

    assert.isEmpty(providerCwds, "no provider should open in the project checkout");
    assert.equal(second.task.threadId, threadId);
    assert.equal(second.task.lastRun?.dispatchStatus, "failed");
    assert.include(second.task.lastRunError, "Attach a worktree");
    assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { refusal: "a missing worktree", lookupFailure: undefined },
  { refusal: "a failed message lookup", lookupFailure: "Transient candidate-message read failure" },
])(
  "a relay webhook refused due to $refusal succeeds with the same delivery after attachment",
  ({ lookupFailure }) => {
    const { layer, tasksLayer, prepareInterruptedAutomation, threadId } =
      worktreeAutomationHarness();
    return Effect.gen(function* () {
      yield* prepareInterruptedAutomation();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* Threads.ThreadManagementService;
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* fs.makeTempDirectoryScoped({ prefix: "automation-worktree-" });
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.ScheduledTaskService;
        const task = yield* create({
          enabled: true,
          schedule: { type: "webhook" },
          threadId,
          threadMode: "continue",
        });
        const projections = yield* Projections.ProjectionStoreV2;
        using _lookup =
          lookupFailure === undefined
            ? undefined
            : vi
                .spyOn(projections, "getMessagesById")
                .mockImplementationOnce((threadId) =>
                  Effect.fail(
                    new Projections.ProjectionStoreReadError({ threadId, cause: lookupFailure }),
                  ),
                );
        const request = requestFor(task, { relayDeliveryId: "relay:worktree-refused" });
        const fire = waitForSpan(
          tasks.triggerWebhook(request),
          "ScheduledTaskService.runWebhookDelivery",
        );
        const firstDelivery = yield* fire;
        assert.equal(firstDelivery._tag, "accepted");
        const failed = (yield* tasks.list()).tasks.find(({ id }) => id === task.id);
        assert.equal(failed?.lastRun?.dispatchStatus, "failed");
        if (lookupFailure === undefined) {
          assert.include(failed?.lastRunError ?? "", "Attach a worktree");
        } else {
          assert.equal(failed?.lastRunError, lookupFailure);
        }
        const firingId = failed?.lastRun?.firingId;
        if (firingId === undefined) return yield* Effect.die("Missing refused firing.");
        const refusedReceipt = yield* threads.receiptStatus(firingId);

        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("attach-automation-worktree"),
          threadId,
          worktreePath,
          expectedWorktreePath: null,
        });
        const retried = yield* fire;
        assert.deepEqual(retried, firstDelivery);
        if (retried._tag !== "accepted") return yield* Effect.die("Relay retry was not admitted.");
        const accepted = (yield* tasks.list()).tasks.find(({ id }) => id === task.id);
        assert.equal(accepted?.lastRun?.dispatchStatus, "accepted");
        assert.equal(accepted?.lastRun?.firingId, firingId);
        assert.isNull(refusedReceipt);
        assert.isNull(accepted?.lastRunError);
        const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.lengthOf(runs, 2);

        const duplicate = yield* tasks.triggerWebhook(request);
        assert.deepEqual(duplicate, { ...retried, outcome: "duplicate" });
        const after = (yield* tasks.list()).tasks.find(({ id }) => id === task.id);
        assert.equal(after?.runCount, accepted?.runCount);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, runs);
      }).pipe(Effect.provide(Layer.fresh(tasksLayer)));
    }).pipe(Effect.provide(layer));
  },
);
it.effect(
  "a local automation can use a thread with another task's cancelled worktree setup",
  () => {
    const { layer, tasksLayer, prepareInterruptedAutomation, threadId } =
      worktreeAutomationHarness();
    return Effect.gen(function* () {
      yield* prepareInterruptedAutomation();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const result = yield* Effect.gen(function* () {
        const tasks = yield* Tasks.ScheduledTaskService;
        const task = yield* create({
          id: ScheduledTaskId.make("local-automation"),
          threadId,
          threadMode: "continue",
        });
        return yield* tasks.runNow({ id: task.id });
      }).pipe(Effect.provide(Layer.fresh(tasksLayer)));

      assert.equal(result.task.lastRun?.dispatchStatus, "accepted");
      assert.equal(result.threadId, threadId);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(projection.thread.worktreePath);
      assert.lengthOf(projection.runs, 2);
      const message = projection.messages.find(
        ({ scheduledTaskId }) => scheduledTaskId === result.task.id,
      );
      assert.equal(message?.runId, result.task.lastRun?.runId);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
  "commits %s with the exact firing and publishes it through the shared task subscription",
  (status) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const projections = yield* Projections.ProjectionStoreV2;
      const task = yield* create();
      const ran = yield* tasks.runNow({ id: task.id });
      assert.equal(ran.task.lastRun?.status, "queued");
      assert.equal(ran.task.lastRunStatus, "running");
      const projection = yield* projections.getThreadProjection(ran.threadId!);
      const run = projection.runs[0]!;
      const subscribed = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      yield* tasks.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          if (tasks[0]?.lastRun?.status === status) return Deferred.succeed(done, undefined);
          return Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* update(run, status);
      yield* Deferred.await(done);
      const current = (yield* tasks.list()).tasks[0]!;
      assert.equal(current.lastRun?.runId, run.id);
      assert.equal(current.lastRun?.status, status);
      assert.equal(current.lastRunStatus, status === "completed" ? "succeeded" : "failed");
      assert.equal(current.runCount, 1);
      const before = current.nextRunAt;
      yield* update(run, status, `${status}:duplicate`);
      assert.equal((yield* tasks.list()).tasks[0]?.nextRunAt, before);
    }).pipe(Effect.provide(harness())),
);

it.effect.each([
  { status: "failed", failure: "Weekly usage limit reached", error: "Weekly usage limit reached" },
  { status: "failed", failure: null, error: "The run failed." },
  { status: "failed", failure: "x".repeat(4_096), error: `${"x".repeat(499)}…` },
  // An emoji across the cut is dropped whole, not split into half a surrogate pair.
  {
    status: "failed",
    failure: `${"x".repeat(498)}😀${"x".repeat(100)}`,
    error: `${"x".repeat(498)}…`,
  },
  { status: "interrupted", failure: null, error: "The run was stopped." },
  { status: "cancelled", failure: null, error: "The run was cancelled." },
] as const)(
  "a run that ends $status after its message was accepted records why on its task",
  (outcome) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const projections = yield* Projections.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const task = yield* create();
      const ran = yield* tasks.runNow({ id: task.id });
      const run = (yield* projections.getThreadProjection(ran.threadId!)).runs[0]!;
      if (outcome.failure !== null) {
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("provider-failure"),
              type: "turn-item.updated",
              threadId: run.threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:provider-failure"),
                type: "error",
                threadId: run.threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: "Provider failure",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: outcome.failure,
                  code: null,
                  retryable: null,
                },
              },
            },
          ],
        });
      }
      yield* update(run, outcome.status);
      const current = (yield* tasks.list()).tasks[0]!;
      assert.equal(current.lastRun?.status, outcome.status);
      assert.equal(current.lastRunError, outcome.error);
      // A later receipt change for the same run keeps the stored reason.
      yield* TestClock.adjust("1 second");
      yield* update(run, outcome.status, `${outcome.status}:duplicate`);
      assert.equal((yield* tasks.list()).tasks[0]?.lastRunError, outcome.error);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "rolls the event and projection back when a receipt write fails and retry commits once",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const task = yield* create();
      const ran = yield* tasks.runNow({ id: task.id });
      const run = (yield* store.getThreadProjection(ran.threadId!)).runs[0]!;
      const before = yield* sink.latestSequence();
      yield* sql`CREATE TRIGGER fail_outcome BEFORE UPDATE ON scheduled_task_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(FAIL,'synthetic receipt failure'); END`;
      yield* update(run, "completed").pipe(Effect.flip);
      assert.equal(yield* sink.latestSequence(), before);
      assert.equal((yield* store.getThreadProjection(run.threadId)).runs[0]?.status, "queued");
      assert.equal((yield* tasks.list()).tasks[0]?.lastRun?.status, "queued");
      yield* sql`DROP TRIGGER fail_outcome`;
      yield* update(run, "completed");
      assert.equal((yield* tasks.list()).tasks[0]?.lastRun?.status, "completed");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "message rebind wins over stale launch and same-batch placeholder cancellation for many firings",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const sink = yield* EventSink.EventSinkV2;
      const runs = yield* Runs.ScheduledTaskRuns;
      const store = yield* Projections.ProjectionStoreV2;
      const task = yield* create();
      const first = yield* tasks.runNow({ id: task.id });
      const projection = yield* store.getThreadProjection(first.threadId!);
      const run = projection.runs[0]!;
      const message = projection.messages[0]!;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* runs.begin({
        task,
        firingId: CommandId.make("second"),
        messageId: MessageId.make("second-message"),
        requestedAt: at,
        triggerKind: "manual",
        webhookDeliveryId: null,
      });
      const joined = {
        ...run,
        id: RunId.make("run:joined"),
        userMessageId: MessageId.make("active-message"),
        ordinal: 2,
        status: "running" as const,
      };
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("cancel-placeholder"),
            type: "run.updated",
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...run, status: "cancelled", completedAt: now },
          },
          {
            id: EventId.make("joined-run"),
            type: "run.created",
            threadId: run.threadId,
            occurredAt: now,
            payload: joined,
          },
          {
            id: EventId.make("first-rebound"),
            type: "message.updated",
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...message, runId: joined.id },
          },
          {
            id: EventId.make("second-message"),
            type: "message.updated",
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...message, id: MessageId.make("second-message"), runId: joined.id },
          },
        ],
      });
      const latest = yield* runs.finishDispatch({
        firingId: CommandId.make("second"),
        acceptedRun: run,
        at,
        dispatchEvidence: "unresolved",
      });
      const stale = yield* runs.finishDispatch({
        firingId: first.task.lastRun!.firingId,
        acceptedRun: run,
        at,
        dispatchEvidence: "unresolved",
      });
      assert.equal(stale.runId, joined.id);
      assert.equal(latest.runId, joined.id);
      assert.equal(latest.status, "running");
      yield* update(joined, "completed");
      assert.equal((yield* tasks.list()).tasks[0]?.lastRun?.status, "completed");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "no-op terminal observer is replaceable and its failure rolls back final attribution",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const decisions = yield* Queue.unbounded<Parameters<Runs.FiringTerminalObserver>[0]>();
      let reject = true;
      const configured = Layer.effect(
        Runs.ScheduledTaskRuns,
        Runs.make({
          onFiringTerminal: (input) =>
            reject
              ? new ScheduledTaskError({ message: "Synthetic decision failure." })
              : Queue.offer(decisions, input).pipe(Effect.asVoid),
        }),
      );
      const store = yield* Effect.gen(function* () {
        return yield* Runs.ScheduledTaskRuns;
      }).pipe(Effect.provide(configured));
      // The observer is also reached by finishDispatch during recovery of an already committed terminal projection.
      const tasks = yield* Tasks.ScheduledTaskService;
      const projections = yield* Projections.ProjectionStoreV2;
      const task = yield* create();
      const ran = yield* tasks.runNow({ id: task.id });
      const run = (yield* projections.getThreadProjection(ran.threadId!)).runs[0]!;
      yield* sql`UPDATE scheduled_task_runs SET dispatch_bookkept_at=NULL`;
      // A persisted projection can be ahead after a crash; do not manufacture receipt acceptance from a return value.
      yield* update(run, "completed");
      yield* sql`UPDATE scheduled_task_runs SET status='queued',snapshot_json=json_set(snapshot_json,'$.status','queued','$.completedAt',NULL),completed_at=NULL`;
      yield* store
        .finishDispatch({
          firingId: ran.task.lastRun!.firingId,
          acceptedRun: null,
          at: DateTime.formatIso(yield* DateTime.now),
          dispatchEvidence: "unresolved",
        })
        .pipe(Effect.flip);
      assert.equal(
        (yield* sql<{ status: string }>`SELECT status FROM scheduled_task_runs`)[0]?.status,
        "queued",
      );
      reject = false;
      yield* store.reconcile;
      const decision = yield* Queue.take(decisions);
      assert.equal(decision.runId, run.id);
      assert.equal(decision.status, "completed");
      yield* store.reconcile;
      assert.equal(yield* Queue.size(decisions), 0);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "unrelated events use zero receipt queries, list uses one join, and metadata updates do not rewrite task mirrors",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const runs = yield* Runs.ScheduledTaskRuns;
      const projections = yield* Projections.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const task = yield* create();
      const ran = yield* tasks.runNow({ id: task.id });
      const projection = yield* projections.getThreadProjection(ran.threadId!);
      const queries: string[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const attribute = span.attribute.bind(span);
          span.attribute = (key, value) => {
            if (key === "db.query.text" && typeof value === "string") queries.push(value);
            attribute(key, value);
          };
          return span;
        },
      });
      const now = yield* DateTime.now;
      assert.isFalse(
        yield* runs
          .record([
            {
              sequence: 100,
              commandId: null,
              event: {
                id: EventId.make("unrelated"),
                threadId: projection.thread.id,
                occurredAt: now,
                type: "thread.created",
                payload: projection.thread,
              },
            },
          ])
          .pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true)),
      );
      assert.lengthOf(queries, 0);
      yield* tasks.list().pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
      assert.lengthOf(queries, 1);
      assert.include(queries[0]!, "LEFT JOIN scheduled_task_runs");
      queries.length = 0;
      const before = yield* sink.latestSequence();
      yield* sink
        .commitCommand({
          commandId: CommandId.make("cause-only"),
          threadId: projection.thread.id,
          commandType: "synthetic",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("cause-only"),
              threadId: projection.thread.id,
              occurredAt: now,
              type: "run.updated",
              payload: { ...projection.runs[0]!, terminationCause: { kind: "unknown" } },
            },
          ],
        })
        .pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
      const receiptWrites = queries.filter((query) => /UPDATE scheduled_task_runs SET/.test(query));
      const mirrorWrites = queries.filter((query) => /UPDATE scheduled_tasks SET/.test(query));
      assert.lengthOf(receiptWrites, 1);
      assert.lengthOf(mirrorWrites, 0);
      assert.equal((yield* sink.latestSequence()) - before, 1);
      const codec = Schema.fromJsonString(ScheduledTaskRun);
      const bytes = Buffer.byteLength(yield* Schema.encodeEffect(codec)(ran.task.lastRun!));
      assert.isBelow(bytes, 1024);
      yield* Console.log("Scheduled outcome query budget", {
        unrelatedQueries: 0,
        listQueries: 1,
        metadataReceiptWrites: receiptWrites.length,
        metadataMirrorWrites: mirrorWrites.length,
        extraDomainEvents: 0,
        lastRunBytes: bytes,
      });
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "older firing completion leaves the latest queued firing and scheduling count unchanged",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const projections = yield* Projections.ProjectionStoreV2;
      const task = yield* create();
      const first = yield* tasks.runNow({ id: task.id });
      const run = (yield* projections.getThreadProjection(first.threadId!)).runs[0]!;
      yield* TestClock.adjust("1 millis");
      const second = yield* tasks.runNow({ id: task.id });
      const before = (yield* tasks.list()).tasks[0]!;
      yield* update(run, "completed");
      const after = (yield* tasks.list()).tasks[0]!;
      assert.deepEqual(after.lastRun, second.task.lastRun);
      assert.equal(after.runCount, 2);
      assert.equal(after.nextRunAt, before.nextRunAt);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "durable acceptance overrides a rejection snapshot and clears its dispatch-failure timestamp",
  () =>
    Effect.gen(function* () {
      const runs = yield* Runs.ScheduledTaskRuns;
      const sink = yield* EventSink.EventSinkV2;
      const task = yield* create();
      const at = DateTime.formatIso(yield* DateTime.now);
      const firingId = CommandId.make("firing:late-proof");
      const messageId = MessageId.make("message:late-proof");
      yield* runs.begin({
        task,
        firingId,
        messageId,
        requestedAt: at,
        triggerKind: "manual",
        webhookDeliveryId: null,
      });
      yield* runs.finishDispatch({ firingId, acceptedRun: null, at, dispatchEvidence: "rejected" });
      const accepted = yield* syntheticLaunch(sink)(
        {
          commandId: firingId,
          projectId,
          title: "Synthetic",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
          initialMessage: {
            messageId,
            scheduledTaskId: task.id,
            text: "Synthetic",
            attachments: [],
          },
        },
        "queued",
      );
      const receipt = yield* runs.finishDispatch({
        firingId,
        acceptedRun: null,
        at,
        dispatchEvidence: "rejected",
      });
      assert.equal(receipt.dispatchStatus, "accepted");
      assert.equal(receipt.runId, accepted.projection.runs[0]?.id);
      assert.equal(receipt.status, "queued");
      assert.equal(receipt.completedAt, null);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "a persisted message without a run binding is unresolved rather than proof of dispatch rejection",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const runs = yield* Runs.ScheduledTaskRuns;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const task = yield* create();
      const first = yield* tasks.runNow({ id: task.id });
      const projection = yield* projections.getThreadProjection(first.threadId!);
      const now = yield* DateTime.now;
      const firingId = CommandId.make("message-only");
      const messageId = MessageId.make("message-only");
      const at = DateTime.formatIso(now);
      yield* runs.begin({
        task,
        firingId,
        messageId,
        requestedAt: at,
        triggerKind: "manual",
        webhookDeliveryId: null,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("message-only"),
            type: "message.updated",
            threadId: projection.thread.id,
            occurredAt: now,
            payload: { ...projection.messages[0]!, id: messageId, runId: null },
          },
        ],
      });
      const result = yield* runs.finishDispatch({
        firingId,
        acceptedRun: null,
        at,
        dispatchEvidence: "rejected",
      });
      assert.equal(result.dispatchStatus, "unknown");
      assert.equal(result.status, "unknown");
    }).pipe(Effect.provide(harness())),
);
