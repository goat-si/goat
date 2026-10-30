import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert } from "@effect/vitest";
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
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
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

export const instanceId = ProviderInstanceId.make("codex");
export const driver = ProviderDriverKind.make("codex");
export const parentModel = { instanceId, model: "author-model" };
export const childModel = { instanceId, model: "reviewer-model" };
export const parentId = ThreadId.make("continue-review-parent");
export const baseTime = "2026-10-30T00:00:00.000Z";
export const at = DateTime.makeUnsafe(baseTime);
export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("continue-review"),
  requestNamespace: "continue-review",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: { threadId: parentId, providerInstanceId: instanceId, providerSessionId: "session" },
};
export const providerSnapshot: ServerProvider = {
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
export const providerMode = { cloud: false };
export const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.sync(() =>
      providerMode.cloud
        ? {
            ...CodexProviderCapabilitiesV2,
            sessions: { ...CodexProviderCapabilitiesV2.sessions, executionLocation: "cloud" },
          }
        : CodexProviderCapabilitiesV2,
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Continuation tests never start providers"),
};
export const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "review-continuation" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);
// The same database layer reference, so goatclaw lanes share the projection tables.
export const layerTestWithSql = Layer.merge(layerTest, SqlitePersistence.layerMemory);

/** The value, or a defect naming what the fixture expected to find. */
const required = <A>(value: A | null | undefined, what: string): Effect.Effect<A> =>
  value === null || value === undefined
    ? Effect.die(new Error("Fixture is missing " + what))
    : Effect.succeed(value);

let eventCounter = 0;
export const nextEventId = () => EventId.make("continue-review-event-" + ++eventCounter);

/** What the provider boundary writes when a run's attempt hands its brief to a native thread. */
export const recordProviderTurn = (input: {
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
    const current = yield* required(
      (yield* store.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === input.run.id,
      ),
      "the run",
    );
    yield* store.apply({
      id: nextEventId(),
      type: "run.updated",
      threadId,
      runId: input.run.id,
      occurredAt: at,
      payload: { ...current, status: input.runStatus, completedAt: at },
    });
  });

export const finishTask = (taskId: NodeId, status: OrchestrationV2Subagent["status"]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const task = yield* required(
      (yield* store.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (candidate) => candidate.id === taskId,
      ),
      "the task",
    );
    yield* store.apply({
      id: nextEventId(),
      type: "subagent.updated",
      threadId: parentId,
      occurredAt: at,
      payload: { ...task, status, result: "Review " + status, completedAt: at },
    });
  });

export const childRuns = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* store.getThreadRecords(childThreadId, ["runs"])).runs.toSorted(
      (left, right) => left.ordinal - right.ordinal,
    );
  });

/** A parent with a finished first review round whose brief completed on native-1. */
export const makeFixture = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(baseTime));
  providerMode.cloud = false;
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
  const parentRun = yield* required(
    (yield* store.getThreadRecords(parentId, ["runs"])).runs[0],
    "the parent run",
  );
  const parentNodeId = yield* required(parentRun.rootNodeId, "the parent root node");
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("review-round-1"),
    parentThreadId: parentId,
    parentRunId: parentRun.id,
    parentNodeId,
    task: "Review the diff",
    role: "review",
    modelSelection: childModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const first = yield* required(
    (yield* store.getThreadRecords(parentId, ["subagents"])).subagents[0],
    "the first review task",
  );
  const childThreadId = yield* required(first.childThreadId, "the reviewer thread");
  const [firstRun] = yield* childRuns(childThreadId);
  yield* recordProviderTurn({
    run: yield* required(firstRun, "the first review run"),
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

export type Fixture = Effect.Success<typeof makeFixture>;

export interface ServiceOptions {
  /** Turns goatclaw on with one lane, backed by the harness database. */
  readonly goatclaw?: boolean;
  /** Runs inside the next review-continue dispatch, after MCP preflight and before commit. */
  readonly race?: { current: Effect.Effect<void> | undefined };
  /** The next read of the parent's tasks returns these, as a call that read before a commit. */
  readonly staleTasks?: { current: ReadonlyArray<OrchestrationV2Subagent> | undefined };
}

export const serviceLayer = ({ orchestrator, store }: Fixture, options: ServiceOptions = {}) =>
  Effect.gen(function* () {
    const receipts = yield* Effect.serviceOption(CommandReceiptStore.CommandReceiptStoreV2);
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const ownerProfile = yield* required(BUILTIN_PERMISSION_PROFILES.owner, "the owner profile");
    const { race: raceRef, staleTasks } = options;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest({
        goatclaw: {
          enabled: options.goatclaw === true,
          defaultProfile: "owner",
          profiles: { owner: { ...ownerProfile, maxLanes: 1 } },
        },
      }),
      ...(options.goatclaw === true && Option.isSome(sql)
        ? [Layer.succeed(SqlClient.SqlClient, sql.value)]
        : []),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) => {
          const race = raceRef?.current;
          if (
            command.type !== "delegated_task.review-continue" ||
            raceRef === undefined ||
            race === undefined
          )
            return orchestrator.dispatch(command);
          raceRef.current = undefined;
          return Effect.andThen(race, orchestrator.dispatch(command));
        },
        hasReceipt: (commandId) =>
          Option.match(receipts, {
            onNone: () => Effect.succeed(false),
            onSome: (stored) =>
              stored.getByCommandId(commandId).pipe(Effect.map(Option.isSome), Effect.orDie),
          }),
        getThreadRecords: (id, fields, filter) =>
          store.getThreadRecords(id, fields, filter).pipe(
            Effect.orDie,
            Effect.map((records) => {
              const stale = staleTasks?.current;
              if (
                id !== parentId ||
                staleTasks === undefined ||
                stale === undefined ||
                !(fields as ReadonlyArray<string>).includes("subagents")
              )
                return records;
              staleTasks.current = undefined;
              return { ...records, subagents: stale };
            }),
          ),
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

export const withService = <A, E, R>(
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

export const continueInput = (fixture: Fixture, extra: object = {}) => ({
  task: "Round 2: re-check finding f1 against the new commit.",
  role: "review" as const,
  continueFrom: fixture.first.id,
  clientRequestId: "round-2",
  ...extra,
});

export const continued = (fixture: Fixture) =>
  withService(fixture, (service) => service.delegateTask(scope, continueInput(fixture)));

/** A finished run in the reviewer thread that no task owns, as a server-sent message makes. */
export const sendUnbound = (fixture: Fixture, id: string, text: string) =>
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
    const run = yield* required((yield* childRuns(fixture.childThreadId)).at(-1), "the sent run");
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
