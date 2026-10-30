import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const parentModel = { instanceId, model: "author-model" };
const childModel = { instanceId, model: "reviewer-model" };
const parentId = ThreadId.make("continue-review-parent");
const baseTime = "2026-10-30T00:00:00.000Z";
const at = DateTime.makeUnsafe(baseTime);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("continue-review"),
  requestNamespace: "continue-review",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: { threadId: parentId, providerInstanceId: instanceId, providerSessionId: "session" },
};
const providerSnapshot: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: baseTime,
  models: ["author-model", "reviewer-model", "other-model"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
};
let cloudProvider = false;
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.sync(() =>
      cloudProvider
        ? {
            ...CodexProviderCapabilitiesV2,
            sessions: { ...CodexProviderCapabilitiesV2.sessions, executionLocation: "cloud" },
          }
        : CodexProviderCapabilitiesV2,
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Continuation tests never start providers"),
};
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "review-continuation" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);
// The same database layer reference, so goatclaw lanes share the projection tables.
const layerTestWithSql = Layer.merge(layerTest, SqlitePersistence.layerMemory);

let eventCounter = 0;
const nextEventId = () => EventId.make("continue-review-event-" + ++eventCounter);

/** What the provider boundary writes when a run's attempt hands its brief to a native thread. */
const recordProviderTurn = (input: {
  readonly run: OrchestrationV2Run;
  readonly nativeId: string | undefined;
  readonly turn: "completed" | "failed" | "none";
  readonly reason?: "initial" | "steering_restart";
  readonly attemptOrdinal?: number;
  readonly runStatus: OrchestrationV2Run["status"];
}) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = input.run.threadId;
    const providerThreadId = ProviderThreadId.make("provider-thread:" + threadId);
    const existing = (yield* store.getThreadRecords(threadId, ["attempts"])).attempts.find(
      (attempt) =>
        attempt.runId === input.run.id && attempt.attemptOrdinal === (input.attemptOrdinal ?? 1),
    );
    const attemptId =
      existing?.id ??
      RunAttemptId.make("attempt:" + input.run.id + ":" + (input.attemptOrdinal ?? 1));
    yield* store.apply({
      id: nextEventId(),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef:
          input.nativeId === undefined
            ? null
            : { driver, nativeId: input.nativeId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: input.run.ordinal,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: at,
        updatedAt: at,
      },
    });
    yield* store.apply({
      id: nextEventId(),
      type: "run-attempt.updated",
      threadId,
      runId: input.run.id,
      occurredAt: at,
      payload: {
        id: attemptId,
        ...(input.nativeId === undefined ? {} : { nativeThreadId: input.nativeId }),
        runId: input.run.id,
        attemptOrdinal: input.attemptOrdinal ?? 1,
        rootNodeId: input.run.rootNodeId ?? NodeId.make("root:" + input.run.id),
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: input.reason ?? "initial",
        status: input.turn === "completed" ? "completed" : "failed",
        startedAt: at,
        completedAt: at,
      },
    });
    if (input.turn !== "none")
      yield* store.apply({
        id: nextEventId(),
        type: "provider-turn.updated",
        threadId,
        runId: input.run.id,
        occurredAt: at,
        payload: {
          id: ProviderTurnId.make("turn:" + attemptId),
          providerThreadId,
          nodeId: input.run.rootNodeId ?? NodeId.make("root:" + input.run.id),
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: input.run.ordinal * 10 + (input.attemptOrdinal ?? 1),
          status: input.turn,
          startedAt: at,
          completedAt: at,
        },
      });
    const current = (yield* store.getThreadRecords(threadId, ["runs"])).runs.find(
      (run) => run.id === input.run.id,
    )!;
    yield* store.apply({
      id: nextEventId(),
      type: "run.updated",
      threadId,
      runId: input.run.id,
      occurredAt: at,
      payload: { ...current, status: input.runStatus, completedAt: at },
    });
  });

const finishTask = (taskId: NodeId, status: OrchestrationV2Subagent["status"]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const task = (yield* store.getThreadRecords(parentId, ["subagents"])).subagents.find(
      (candidate) => candidate.id === taskId,
    )!;
    yield* store.apply({
      id: nextEventId(),
      type: "subagent.updated",
      threadId: parentId,
      occurredAt: at,
      payload: { ...task, status, result: "Review " + status, completedAt: at },
    });
  });

const childRuns = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* store.getThreadRecords(childThreadId, ["runs"])).runs.toSorted(
      (left, right) => left.ordinal - right.ordinal,
    );
  });

/** A parent with a finished first review round whose brief completed on native-1. */
const makeFixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(baseTime));
  cloudProvider = false;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("parent-create"),
    threadId: parentId,
    projectId: ProjectId.make("review-project"),
    title: "Author",
    modelSelection: parentModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("parent-start"),
    threadId: parentId,
    messageId: MessageId.make("parent-prompt"),
    text: "Delegate a review",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parentRun = (yield* store.getThreadRecords(parentId, ["runs"])).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("review-round-1"),
    parentThreadId: parentId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: "Review the diff",
    role: "review",
    modelSelection: childModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const first = (yield* store.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
  const childThreadId = first.childThreadId!;
  const [firstRun] = yield* childRuns(childThreadId);
  yield* recordProviderTurn({
    run: firstRun!,
    nativeId: "native-1",
    turn: "completed",
    runStatus: "completed",
  });
  yield* finishTask(first.id, "completed");
  yield* orchestrator.dispatch({
    type: "delegated_task.review-ledger.append",
    commandId: CommandId.make("round-1-ledger"),
    parentThreadId: parentId,
    taskId: first.id,
    entries: [
      {
        kind: "decision",
        findingId: "f1",
        severity: "low",
        cites: "a.ts:1",
        summary: "Edge case",
        decision: "accepted",
        evidence: null,
      },
    ],
  });
  return { orchestrator, store, first, childThreadId, parentRun };
});

type Fixture = Effect.Success<typeof makeFixture>;

interface ServiceOptions {
  /** Turns goatclaw on with one lane, backed by the harness database. */
  readonly goatclaw?: boolean;
  /** Runs inside the next review-continue dispatch, after MCP preflight and before commit. */
  readonly race?: { current: Effect.Effect<void> | undefined };
}

const serviceLayer = ({ orchestrator, store }: Fixture, options: ServiceOptions = {}) =>
  Effect.gen(function* () {
    const receipts = yield* Effect.serviceOption(CommandReceiptStore.CommandReceiptStoreV2);
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest({
        goatclaw: {
          enabled: options.goatclaw === true,
          defaultProfile: "owner",
          profiles: { owner: { ...BUILTIN_PERMISSION_PROFILES.owner!, maxLanes: 1 } },
        },
      }),
      ...(options.goatclaw === true && Option.isSome(sql)
        ? [Layer.succeed(SqlClient.SqlClient, sql.value)]
        : []),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) => {
          const race = options.race?.current;
          if (command.type !== "delegated_task.review-continue" || race === undefined)
            return orchestrator.dispatch(command);
          options.race!.current = undefined;
          return Effect.andThen(race, orchestrator.dispatch(command));
        },
        hasReceipt: (commandId) =>
          Option.match(receipts, {
            onNone: () => Effect.succeed(false),
            onSome: (stored) =>
              stored.getByCommandId(commandId).pipe(Effect.map(Option.isSome), Effect.orDie),
          }),
        getThreadRecords: (id, fields, filter) =>
          store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
        getReviewLedgerEntries: (input) => store.getReviewLedgerEntries(input).pipe(Effect.orDie),
        getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
        getProjectThreadRecords: (target, fields, filter) =>
          store.getThreadRecords(target.threadId, fields, filter).pipe(Effect.orDie),
        delegatedTaskResultPending: () => Effect.succeed(false),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([providerSnapshot]),
        refreshInstance: () => Effect.succeed([providerSnapshot]),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        get: () => Effect.succeed(adapter),
        list: () => Effect.succeed([instanceId]),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        get: () => Effect.succeed(null),
      }),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ callHostTool: () => Effect.succeed({}) }),
    );
    return OrchestratorMcpService.layer.pipe(
      Layer.provide(layerNoFleetSync),
      Layer.provide(dependencies),
    );
  });

const withService = <A, E, R>(
  fixture: Fixture,
  body: (
    service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  ) => Effect.Effect<A, E, R>,
  options: ServiceOptions = {},
) =>
  Effect.gen(function* () {
    const layer = yield* serviceLayer(fixture, options);
    return yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap(body),
      Effect.provide(layer),
    );
  });

const continueInput = (fixture: Fixture, extra: object = {}) => ({
  task: "Round 2: re-check finding f1 against the new commit.",
  role: "review" as const,
  continueFrom: fixture.first.id,
  clientRequestId: "round-2",
  ...extra,
});

it.effect(
  "continueFrom starts a new review task in the same reviewer thread with its own ledger",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const created = yield* service.delegateTask(scope, continueInput(fixture));
          assert.notEqual(created.taskId, fixture.first.id);
          assert.equal(created.childThreadId, fixture.childThreadId);
          assert.equal(created.role, "review");
          assert.isUndefined(created.reviewLedger);
          assert.deepEqual(created.reviewRound, {
            continuedFrom: fixture.first.id,
            conversation: "starting",
            compacted: false,
          });
          const tasks = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents;
          assert.lengthOf(tasks, 2);
          assert.lengthOf(tasks.find((task) => task.id === fixture.first.id)!.reviewLedger!, 1);
          const runs = yield* childRuns(fixture.childThreadId);
          assert.lengthOf(runs, 2);
          assert.equal(runs[1]!.delegatedTaskId, created.taskId);
          const messages = (yield* fixture.store.getThreadRecords(fixture.childThreadId, [
            "messages",
          ])).messages;
          assert.equal(
            messages.find((message) => message.id === runs[1]!.userMessageId)?.text,
            continueInput(fixture).task,
          );
          // A retry with the same clientRequestId returns the same round while it runs.
          const retried = yield* service.delegateTask(scope, continueInput(fixture));
          assert.equal(retried.taskId, created.taskId);
          assert.lengthOf(yield* childRuns(fixture.childThreadId), 2);
          // The same id aimed at another round is refused rather than replayed.
          const reused = yield* service
            .delegateTask(scope, continueInput(fixture, { continueFrom: NodeId.make("other") }))
            .pipe(Effect.flip);
          assert.equal(reused.code, "invalid_request");

          yield* recordProviderTurn({
            run: runs[1]!,
            nativeId: "native-1",
            turn: "completed",
            runStatus: "completed",
          });
          const status = yield* service.taskStatus(scope, created.taskId);
          assert.equal(status.reviewRound?.conversation, "continued");
          const fresh = yield* service.taskStatus(scope, fixture.first.id);
          assert.deepEqual(fresh.reviewRound, {
            continuedFrom: null,
            conversation: "new",
            compacted: false,
          });
          yield* service.recordReviewFindings(scope, {
            taskId: created.taskId,
            entries: [
              {
                kind: "decision",
                findingId: "f2",
                severity: "low",
                cites: null,
                summary: "Still open",
                decision: "accepted",
                evidence: null,
              },
            ],
          });
          const exported = yield* service.exportReviewFindings(scope, {
            from: "2026-10-29T00:00:00.000Z",
            to: "2026-10-31T00:00:00.000Z",
          });
          const lines = exported.jsonl
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { taskId: string; continuedFrom: string | null });
          assert.deepEqual(
            lines.map((line) => [line.taskId, line.continuedFrom]),
            [
              [fixture.first.id, null],
              [created.taskId, fixture.first.id],
            ].toSorted((left, right) => left[0]!.localeCompare(right[0]!)),
          );
        }),
      );
    }).pipe(Effect.provide(layerTest)),
);

const continued = (fixture: Fixture) =>
  withService(fixture, (service) => service.delegateTask(scope, continueInput(fixture)));

const childTurnItemsOrdinal = 100;

it.effect.each([
  { name: "brief completed on the earlier conversation", expected: "continued" },
  { name: "resume moved the brief to another conversation", expected: "recovered" },
  { name: "a steering restart moved to another conversation", expected: "recovered" },
  { name: "a provider turn without a native thread id", expected: "unverified" },
  { name: "the brief never completed and the task failed", expected: "not_started" },
  { name: "only a steering restart completed", expected: "unverified" },
  { name: "the conversation was rolled back", expected: "rewound" },
] as const)("reviewRound reports $expected when $name", ({ name, expected }) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    const record = (
      nativeId: string | undefined,
      turn: "completed" | "failed",
      attemptOrdinal = 1,
    ) =>
      recordProviderTurn({
        run,
        nativeId,
        turn,
        attemptOrdinal,
        reason: attemptOrdinal === 1 ? "initial" : "steering_restart",
        runStatus: turn === "completed" ? "completed" : "failed",
      });
    let taskStatus: OrchestrationV2Subagent["status"] = "completed";
    switch (name) {
      case "brief completed on the earlier conversation":
        yield* record("native-1", "completed");
        break;
      case "resume moved the brief to another conversation":
        yield* record("native-2", "completed");
        break;
      case "a steering restart moved to another conversation":
        yield* record("native-1", "completed");
        yield* record("native-2", "completed", 2);
        break;
      case "a provider turn without a native thread id":
        yield* record(undefined, "completed");
        break;
      case "the brief never completed and the task failed":
        yield* record("native-1", "failed");
        taskStatus = "failed";
        break;
      case "only a steering restart completed":
        yield* record("native-1", "failed");
        yield* record("native-1", "completed", 2);
        break;
      case "the conversation was rolled back": {
        yield* record("native-1", "completed");
        const child = yield* fixture.store.getThread(fixture.childThreadId);
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "thread.metadata-updated",
          threadId: fixture.childThreadId,
          occurredAt: at,
          payload: { ...child, rollbackRequestId: CommandId.make("rollback-later") },
        });
        break;
      }
    }
    yield* finishTask(created.taskId, taskStatus);
    const status = yield* withService(fixture, (service) =>
      service.taskStatus(scope, created.taskId),
    );
    assert.deepEqual(status.reviewRound, {
      continuedFrom: fixture.first.id,
      conversation: expected,
      compacted: false,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reviewRound reports a compaction GOAT recorded in the reviewer conversation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    yield* fixture.store.apply({
      id: nextEventId(),
      type: "turn-item.updated",
      threadId: fixture.childThreadId,
      runId: run.id,
      occurredAt: at,
      payload: {
        id: TurnItemId.make("compaction-item"),
        threadId: fixture.childThreadId,
        runId: run.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: childTurnItemsOrdinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "compaction",
        driver,
      },
    });
    yield* recordProviderTurn({
      run,
      nativeId: "native-1",
      turn: "completed",
      runStatus: "completed",
    });
    const status = yield* withService(fixture, (service) =>
      service.taskStatus(scope, created.taskId),
    );
    assert.deepInclude(status.reviewRound, { conversation: "continued", compacted: true });
    // The compaction came after round 1, so round 1 does not report it.
    const first = yield* withService(fixture, (service) =>
      service.taskStatus(scope, fixture.first.id),
    );
    assert.deepInclude(first.reviewRound, { conversation: "new", compacted: false });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "omitted role", code: "invalid_request", says: "requires role" },
  { name: "another role", code: "invalid_request", says: "requires role" },
  { name: "a remote host", code: "invalid_request", says: "another machine" },
  { name: "worktree isolation", code: "invalid_request", says: "omit isolation" },
  { name: "a slash command brief", code: "invalid_request", says: "slash command" },
  { name: "an unknown task", code: "task_not_found", says: "not a delegated task" },
  { name: "another model", code: "invalid_request", says: "provider and model" },
  { name: "an unfinished earlier round", code: "invalid_request", says: "has not finished" },
  {
    name: "a running turn in the reviewer thread",
    code: "invalid_request",
    says: "running or queued",
  },
  { name: "an earlier brief that never completed", code: "invalid_request", says: "no record" },
  {
    name: "a replaced provider conversation",
    code: "invalid_request",
    says: "conversation changed",
  },
  { name: "a rollback request", code: "invalid_request", says: "rolled back" },
  { name: "a cloud provider", code: "invalid_request", says: "cannot continue a review" },
  { name: "an older round", code: "invalid_request", says: "latest review round" },
] as const)("continueFrom refuses $name and starts nothing", ({ name, code, says }) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const [firstRun] = yield* childRuns(fixture.childThreadId);
    let input: Record<string, unknown> = continueInput(fixture);
    switch (name) {
      case "omitted role":
        input = { ...input, role: undefined };
        break;
      case "another role":
        input = { ...input, role: "general" };
        break;
      case "a remote host":
        input = { ...input, target: { host: "box" }, remote: { cwd: "/repo" } };
        break;
      case "worktree isolation":
        input = { ...input, isolation: "worktree" };
        break;
      case "a slash command brief":
        input = { ...input, task: "/compact keep the tests" };
        break;
      case "an unknown task":
        input = { ...input, continueFrom: NodeId.make("missing-task") };
        break;
      case "another model":
        input = { ...input, target: { model: "other-model" } };
        break;
      case "an unfinished earlier round":
        yield* finishTask(fixture.first.id, "running");
        break;
      case "a running turn in the reviewer thread":
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "run.updated",
          threadId: fixture.childThreadId,
          runId: firstRun!.id,
          occurredAt: at,
          payload: { ...firstRun!, status: "running" },
        });
        break;
      case "an earlier brief that never completed":
        yield* recordProviderTurn({
          run: firstRun!,
          nativeId: "native-1",
          turn: "failed",
          runStatus: "completed",
        });
        break;
      case "a replaced provider conversation":
        yield* recordProviderTurn({
          run: firstRun!,
          nativeId: "native-9",
          turn: "completed",
          attemptOrdinal: 2,
          reason: "steering_restart",
          runStatus: "completed",
        });
        break;
      case "a rollback request": {
        const child = yield* fixture.store.getThread(fixture.childThreadId);
        yield* fixture.store.apply({
          id: nextEventId(),
          type: "thread.metadata-updated",
          threadId: fixture.childThreadId,
          occurredAt: at,
          payload: { ...child, rollbackRequestId: CommandId.make("rollback-1") },
        });
        break;
      }
      case "a cloud provider":
        cloudProvider = true;
        break;
      case "an older round": {
        const second = yield* continued(fixture);
        const run = (yield* childRuns(fixture.childThreadId))[1]!;
        yield* recordProviderTurn({
          run,
          nativeId: "native-1",
          turn: "completed",
          runStatus: "completed",
        });
        yield* finishTask(second.taskId, "completed");
        input = { ...input, clientRequestId: "round-3" };
        break;
      }
    }
    const before = {
      tasks: (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.length,
      runs: (yield* childRuns(fixture.childThreadId)).length,
    };
    const refused = yield* withService(fixture, (service) =>
      service.delegateTask(scope, input as Parameters<typeof service.delegateTask>[1]),
    ).pipe(Effect.flip);
    assert.equal(refused.code, code);
    assert.include(refused.message, says);
    assert.deepEqual(
      {
        tasks: (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.length,
        runs: (yield* childRuns(fixture.childThreadId)).length,
      },
      before,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "the parent run ended",
  "the child is the parent",
  "the child's mode is above the caller's",
] as const)("the review-continue command commits nothing when %s", (name) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const command = {
      type: "delegated_task.review-continue" as const,
      commandId: CommandId.make("direct-continue"),
      threadId: parentId,
      parentRunId: fixture.parentRun.id,
      parentNodeId: fixture.parentRun.rootNodeId!,
      continueFrom: fixture.first.id,
      childThreadId: name === "the child is the parent" ? parentId : fixture.childThreadId,
      task: "Round 2",
      modelSelection: childModel,
      completionWake: "always" as const,
      memoryGrantCeiling: "none" as const,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    let dispatch = fixture.orchestrator.dispatch(command);
    if (name === "the parent run ended") {
      const parentRun = (yield* fixture.store.getThreadRecords(parentId, ["runs"])).runs[0]!;
      yield* fixture.store.apply({
        id: nextEventId(),
        type: "run.updated",
        threadId: parentId,
        runId: parentRun.id,
        occurredAt: at,
        payload: { ...parentRun, status: "completed", completedAt: at },
      });
    }
    if (name === "the child's mode is above the caller's") {
      yield* fixture.orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("parent-plan-mode"),
        threadId: parentId,
        interactionMode: "plan",
      });
      dispatch = dispatch.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "full-access",
          interactionMode: "plan",
        }),
      );
    }
    const before = (yield* childRuns(fixture.childThreadId)).length;
    const refused = yield* dispatch.pipe(Effect.flip);
    assert.include(
      ["OrchestratorDispatchError", "OrchestratorThreadAboveModeLimitError"],
      refused._tag,
    );
    if (name === "the child's mode is above the caller's")
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
    assert.lengthOf((yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents, 1);
    assert.lengthOf(yield* childRuns(fixture.childThreadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("goat_thread_send stays refused after a continued review round finishes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* continued(fixture);
    const run = (yield* childRuns(fixture.childThreadId))[1]!;
    yield* recordProviderTurn({
      run,
      nativeId: "native-1",
      turn: "completed",
      runStatus: "completed",
    });
    yield* finishTask(created.taskId, "completed");
    const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
          Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
          Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, fixture.orchestrator)),
        ),
      ),
    );
    const refused = yield* threads
      .assertReviewTaskSendAllowed({
        threadId: fixture.childThreadId,
        senderThreadId: parentId,
        createdBy: "agent",
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "ThreadManagementReviewTaskFinishedError");
    assert.include(refused.message, "continueFrom");
  }).pipe(Effect.provide(layerTest)),
);

/** A finished run in the reviewer thread that no task owns, as a server-sent message makes. */
const sendUnbound = (fixture: Fixture, id: string, text: string) =>
  Effect.gen(function* () {
    yield* fixture.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-" + id),
      threadId: fixture.childThreadId,
      messageId: MessageId.make("message-" + id),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    const run = (yield* childRuns(fixture.childThreadId)).at(-1)!;
    assert.isUndefined(run.delegatedTaskId);
    yield* fixture.store.apply({
      id: nextEventId(),
      type: "run.updated",
      threadId: fixture.childThreadId,
      runId: run.id,
      occurredAt: at,
      payload: { ...run, status: "completed", completedAt: at },
    });
  });

it.effect("a /compact run after the round does not block continuing it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* sendUnbound(fixture, "compact", "/compact");
    const created = yield* continued(fixture);
    assert.equal(created.reviewRound?.continuedFrom, fixture.first.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an unrelated run after the round blocks continuing it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* sendUnbound(fixture, "unbound", "Something unrelated");
    const refused = yield* continued(fixture).pipe(Effect.flip);
    assert.include(refused.message, "latest review round");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a lane claimed for a continuation that fails to commit is released, and a retry replays the refusal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const [firstRun] = yield* childRuns(fixture.childThreadId);
      const setFirstRun = (status: OrchestrationV2Run["status"]) =>
        fixture.store
          .apply({
            id: nextEventId(),
            type: "run.updated",
            threadId: fixture.childThreadId,
            runId: firstRun!.id,
            occurredAt: at,
            payload: { ...firstRun!, status, completedAt: at },
          })
          .pipe(Effect.orDie);
      // A user message reaches the reviewer between MCP preflight and commit.
      const race: ServiceOptions["race"] = { current: setFirstRun("running") };
      const sql = yield* SqlClient.SqlClient;
      const lanes = () => sql<{ pending: number }>`SELECT pending FROM goatclaw_lane_reservations`;
      yield* withService(
        fixture,
        (service) =>
          Effect.gen(function* () {
            const first = yield* service
              .delegateTask(scope, continueInput(fixture))
              .pipe(Effect.flip);
            assert.equal(first.code, "invalid_request");
            assert.include(first.message, "running or queued");
            assert.lengthOf(yield* lanes(), 0);
            yield* setFirstRun("completed");
            const replayed = yield* service
              .delegateTask(scope, continueInput(fixture))
              .pipe(Effect.flip);
            assert.equal(replayed.code, "invalid_request");
            assert.lengthOf(yield* lanes(), 0);
            // With the lane free, a new request continues the reviewer within maxLanes 1.
            const created = yield* service.delegateTask(
              scope,
              continueInput(fixture, { clientRequestId: "round-2b" }),
            );
            assert.equal(created.childThreadId, fixture.childThreadId);
            assert.deepEqual(
              (yield* lanes()).map((lane) => lane.pending),
              [0],
            );
          }),
        { goatclaw: true, race },
      );
      assert.lengthOf(
        (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents,
        2,
      );
    }).pipe(Effect.provide(layerTestWithSql)),
);

it.effect("a channel-owned caller is refused and its child-work reservation returns", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const released: Array<unknown> = [];
    const record = { id: "child-work-1" } as unknown as Parameters<
      ChannelChildWork.ChannelChildWork["Service"]["releaseReserved"]
    >[0];
    const refused = yield* continued(fixture).pipe(
      Effect.provide(
        Layer.mock(ChannelChildWork.ChannelChildWork)({
          admit: () => Effect.succeed({ _tag: "admitted", record, requestKey: "round-2" }),
          releaseReserved: (reserved) => Effect.sync(() => void released.push(reserved)),
        }),
      ),
      Effect.flip,
    );
    assert.include(refused.message, "channel-owned");
    assert.deepEqual(released, [record]);
    assert.lengthOf((yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents, 1);
    assert.lengthOf(yield* childRuns(fixture.childThreadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["an interrupted call", "two concurrent calls"] as const)(
  "%s with one clientRequestId leave one round holding one lane",
  (name) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      const lanes = () => sql<{ pending: number }>`SELECT pending FROM goatclaw_lane_reservations`;
      const race: ServiceOptions["race"] = {
        current: name === "an interrupted call" ? Effect.interrupt : undefined,
      };
      yield* withService(
        fixture,
        (service) =>
          Effect.gen(function* () {
            if (name === "an interrupted call") {
              const exit = yield* Effect.exit(service.delegateTask(scope, continueInput(fixture)));
              assert.isTrue(exit._tag === "Failure");
              assert.lengthOf(yield* lanes(), 0);
              yield* service.delegateTask(scope, continueInput(fixture));
            } else {
              const [left, right] = yield* Effect.all(
                [
                  service.delegateTask(scope, continueInput(fixture)),
                  service.delegateTask(scope, continueInput(fixture)),
                ],
                { concurrency: 2 },
              );
              assert.equal(left.taskId, right.taskId);
            }
            assert.deepEqual(
              (yield* lanes()).map((lane) => lane.pending),
              [0],
            );
          }),
        { goatclaw: true, race },
      );
      assert.lengthOf(
        (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents,
        2,
      );
    }).pipe(Effect.provide(layerTestWithSql)),
);
