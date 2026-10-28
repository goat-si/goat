import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  layerTest as layerOrchestrator,
  seedParentWithTerminalTask,
} from "../orchestration-v2/DelegatedCompletionDelivery.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const now = DateTime.makeUnsafe("2026-10-28T03:00:00.000Z");
const projectId = ProjectId.make("project:mcp-test");
const otherProjectId = ProjectId.make("project:mcp-other");
const parentId = ThreadId.make("thread:lazy-parent");
const taskId = NodeId.make("node:lazy-task");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:lazy"),
  requestNamespace: "provider-session:lazy",
  thread: {
    threadId: parentId,
    providerSessionId: "provider-session:lazy",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const finished = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(id, { activeRunId: null }),
  latestRunId: RunId.make(`run:${id}`),
  status: "completed",
  ...overrides,
});
const launchedBy = (threadId: ThreadId) => ({
  kind: "launch" as const,
  threadId,
  environmentId: null,
  environmentLabel: null,
  threadTitle: null,
  via: "thread_launch" as const,
});
const pending = (kind: string) =>
  ({
    id: RuntimeRequestId.make(`request:${kind}`),
    kind,
    createdAt: now,
    blocking: true,
  }) as OrchestrationV2ThreadShell["pendingRuntimeRequest"];

/** The store's lineage rows and its shell reads by id, over a fixed set of shells. */
const shellReads = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) => ({
  listLaunchEdges: () =>
    Effect.succeed(
      shells.map((shell) => ({
        id: shell.id,
        projectId: shell.projectId,
        lineage: shell.lineage,
        launchedBy: shell.launchedBy,
        pinnedAt: shell.pinnedAt == null ? null : "2026-10-28T00:00:00.000Z",
      })),
    ),
  getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<ThreadId> }) =>
    Effect.succeed({
      schemaVersion: 1,
      snapshotSequence: 0,
      threads: shells.filter((shell) => options?.threadIds?.includes(shell.id) ?? true),
      archivedThreads: [],
    } as never),
});

const parentProjection = (subagents: ReadonlyArray<unknown>) =>
  ({
    thread: { id: parentId, projectId, runtimeMode: "full-access", interactionMode: "default" },
    runs: [],
    messages: [],
    contextTransfers: [],
    runtimeRequests: [],
    turnItems: [],
    subagents,
  }) as unknown as OrchestrationV2ThreadProjection;

const layerFor = (threads: Partial<ThreadManagementService.ThreadManagementService["Service"]>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)(threads),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

describe("goat_thread_list lineage", () => {
  // The caller launched a, b (in another project) and d, and forked c; b launched a thread that asks.
  const a = ThreadId.make("thread:lazy-a");
  const b = ThreadId.make("thread:lazy-b");
  const c = ThreadId.make("thread:lazy-c");
  const d = ThreadId.make("thread:lazy-d");
  const e = ThreadId.make("thread:lazy-e");
  const remoteTaskChild = ThreadId.make("thread:lazy-remote-task");
  const grandchild = ThreadId.make("thread:lazy-grandchild");
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    finished(parentId, { status: "running", activeRunId: RunId.make("run:parent") }),
    finished(a, {
      launchedBy: launchedBy(parentId),
      latestAnswerExcerpt: "Shipped the fix.",
      pendingRuntimeRequest: pending("user_input"),
    }),
    finished(b, { launchedBy: launchedBy(parentId), projectId: otherProjectId }),
    finished(grandchild, {
      launchedBy: launchedBy(b),
      status: "running",
      activeRunId: RunId.make("run:grandchild"),
      pendingRuntimeRequest: pending("command"),
    }),
    finished(c, {
      lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "fork" },
    }),
    // As in the sidebar, a pinned thread keeps its own row and another machine's launch folds
    // under nothing here, so neither lifts d.
    finished(d, { launchedBy: launchedBy(parentId) }),
    finished(ThreadId.make("thread:lazy-pinned"), {
      launchedBy: launchedBy(d),
      pinnedAt: now,
      status: "running",
      activeRunId: RunId.make("run:pinned"),
    }),
    finished(ThreadId.make("thread:lazy-foreign"), {
      launchedBy: { ...launchedBy(d), environmentId: EnvironmentId.make("environment:other") },
      status: "running",
      activeRunId: RunId.make("run:foreign"),
    }),
    // e's task child is archived, and that child's own child asks; it still counts for e.
    finished(e, { launchedBy: launchedBy(parentId) }),
    finished(ThreadId.make("thread:lazy-e-grandchild"), {
      creationSource: "mcp",
      lineage: {
        rootThreadId: e,
        parentThreadId: ThreadId.make("thread:lazy-archived"),
        relationshipToParent: "subagent",
      },
      status: "running",
      activeRunId: RunId.make("run:e-grandchild"),
      pendingRuntimeRequest: pending("command"),
    }),
    // A goat_task_create child the caller started from another machine, read on this host.
    finished(remoteTaskChild, {
      launchedBy: {
        ...launchedBy(parentId),
        environmentId: EnvironmentId.make("environment:caller"),
        via: "delegate_task",
      },
    }),
    finished(ThreadId.make("thread:lazy-unrelated")),
  ];
  const layer = layerFor({
    ...shellReads(shells),
    listProjectThreads: () => Effect.succeed(shells),
    getThreadRecords: (threadId) =>
      Effect.succeed(
        threadId === a
          ? ({
              // A pending question beside two waiting secret cards and a handoff, which have no
              // runtime request rows; a card from a finished run no longer waits on anyone.
              runtimeRequests: [
                { id: "request:other", status: "pending" },
                { id: "request:done", status: "resolved" },
              ],
              runs: [
                { id: RunId.make("run:a-live"), status: "running" },
                { id: RunId.make("run:a-done"), status: "completed" },
              ],
              turnItems: [
                { id: "card:1", type: "secret_request", status: "waiting", runId: "run:a-live" },
                { id: "card:2", type: "secret_request", status: "waiting", runId: "run:a-live" },
                { id: "card:3", type: "human_handoff", status: "waiting", runId: null },
                { id: "card:old", type: "secret_request", status: "waiting", runId: "run:a-done" },
              ],
            } as unknown as OrchestrationV2ThreadProjection)
          : parentProjection([]),
      ),
  });

  it.effect("lists the caller's children across projects with each subtree's fold state", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const children = yield* service.listThreads(scope, { childrenOf: "self" });
      const byId = new Map(children.threads.map((thread) => [thread.threadId, thread]));
      assert.deepEqual([...byId.keys()].toSorted(), [a, b, c, d, e, remoteTaskChild].toSorted());
      assert.deepInclude(byId.get(remoteTaskChild), { launchedByThreadId: null });
      assert.deepInclude(byId.get(e), { foldState: "attention" });
      assert.deepInclude(byId.get(a), {
        launchedByThreadId: parentId,
        foldState: "attention",
        lastAnsweredLine: "Shipped the fix.",
        pendingRequestCount: 4,
      });
      // b finished, but the thread it launched waits on an approval.
      assert.deepInclude(byId.get(b), { foldState: "attention", pendingRequestCount: 0 });
      assert.deepInclude(byId.get(c), {
        launchedByThreadId: null,
        foldState: "finished",
        lastAnsweredLine: null,
      });
      assert.deepInclude(byId.get(d), { foldState: "finished" });

      const launched = yield* service.listThreads(scope, { launchedBy: "self" });
      assert.deepEqual(
        launched.threads.map((thread) => thread.threadId).toSorted(),
        [a, b, d, e].toSorted(),
      );
      const forks = yield* service.listThreads(scope, { parentThreadId: parentId });
      assert.deepEqual(
        forks.threads.map((thread) => thread.threadId),
        [c],
      );
      const fromB = yield* service.listThreads(scope, { launchedBy: b, projectId });
      assert.deepEqual(
        fromB.threads.map((thread) => thread.threadId),
        [grandchild],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([false, true])(
    "threads that launched each other keep their own fold state (reversed: %s)",
    (reversed) => {
      const x = ThreadId.make("thread:lazy-loop-x");
      const y = ThreadId.make("thread:lazy-loop-y");
      const loop = [
        finished(x, { launchedBy: launchedBy(y) }),
        finished(y, {
          launchedBy: launchedBy(x),
          status: "running",
          activeRunId: RunId.make("run:loop-y"),
          pendingRuntimeRequest: pending("user_input"),
        }),
      ];
      const ordered = reversed ? loop.toReversed() : loop;
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const listed = yield* service.listThreads(scope, { projectId });
        assert.deepEqual(
          Object.fromEntries(listed.threads.map((thread) => [thread.threadId, thread.foldState])),
          { [x]: "finished", [y]: "attention" },
        );
      }).pipe(
        Effect.provide(
          layerFor({
            ...shellReads(ordered),
            listProjectThreads: () => Effect.succeed(ordered),
            getThreadRecords: () =>
              Effect.succeed({
                ...parentProjection([]),
                runtimeRequests: [{ id: "request:user_input", status: "pending" }],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
        ),
      );
    },
  );

  it.effect("refuses self from a caller that is not a GOAT thread", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .listThreads({ ...scope, thread: undefined }, { launchedBy: "self" })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
    }).pipe(Effect.provide(layer)),
  );
});

describe("goat_thread_read summary and tail", () => {
  const childId = ThreadId.make("thread:lazy-task-child");
  const childRunId = RunId.make("run:lazy-task-child");
  const task = {
    id: taskId,
    threadId: parentId,
    origin: "app_owned",
    childThreadId: childId,
    driver: "codex",
    model: "gpt-5.6-terra",
    status: "completed",
    result: "Reviewed: no findings.",
    completionDelivery: { state: "pending" },
    updatedAt: now,
  };
  const childShell = finished(childId, {
    latestRunId: childRunId,
    latestAnswerExcerpt: "Reviewed: no findings.",
    pendingRuntimeRequest: pending("user_input"),
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
  });
  const answer = {
    id: "item:answer",
    type: "assistant_message",
    messageId: "message:answer",
    runId: childRunId,
    ordinal: 4,
    status: "completed",
    title: null,
    updatedAt: now,
    text: "Reviewed: no findings.\nEvery check passed.",
  };
  const childProjection = {
    thread: {
      ...childShell,
      forkedFrom: { type: "node", nodeId: taskId },
      linkedPullRequest: null,
      pullRequests: [],
    },
    runs: [
      {
        id: childRunId,
        ordinal: 1,
        status: "completed",
        delegatedTaskId: taskId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        requestedAt: now,
        startedAt: now,
        completedAt: now,
      },
    ],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    nodes: [],
    // A handoff card waits for the user without a runtime request row.
    turnItems: [
      answer,
      { id: "card:handoff", type: "human_handoff", status: "waiting", runId: null },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const answerRow = {
    position: 4,
    sourceThreadId: childId,
    sourceItemId: answer.id,
    visibility: "local",
    item: answer,
  };
  // The parent recorded the child's result, so a read that returns it in full has seen it.
  const parentWithResult = {
    ...parentProjection([task]),
    contextTransfers: [
      {
        type: "subagent_result",
        sourceThreadId: childId,
        targetThreadId: parentId,
        sourcePoint: { runId: childRunId },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;

  const sent: Array<OrchestrationV2ServerCommand> = [];
  const makeLayer = (dispatched: Array<OrchestrationV2ServerCommand["type"]>) =>
    layerFor({
      ...shellReads([liveThreadShell(parentId), childShell]),
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === childId ? childShell : liveThreadShell(threadId)),
      getProjectThreadRecords: () => Effect.succeed(childProjection),
      getThreadRecords: (threadId) =>
        Effect.succeed(threadId === parentId ? parentWithResult : childProjection),
      getTimelinePage: (_threadId, options) =>
        Effect.succeed({
          items: options.limit === 0 ? [] : [answerRow],
          totalItems: 12,
          // The store pages a 12-item timeline: a zero-item page leaves the rest after it.
          hasMore: options.limit === 0,
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command.type);
          sent.push(command);
          return {} as never;
        }),
    });

  it.effect("a summary read returns the digest instead of the timeline", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const read = yield* service.readThread(scope, { threadId: childId, view: "summary" });
      assert.deepEqual(read.items, []);
      assert.isFalse(read.hasMore);
      assert.lengthOf(read.recentRuns, 1);
      assert.deepEqual(read.summaryDigest, {
        phase: "completed",
        foldState: "attention",
        lastAnsweredLine: "Reviewed: no findings.",
        lastAssistantExcerpt: "Reviewed: no findings.\nEvery check passed.",
        pendingRequests: 1,
        totalItems: 12,
        totalRuns: 1,
      });
      const tail = yield* service.readThread(scope, { threadId: childId, tail: 3 });
      assert.equal(tail.tailStartPosition, 4);
      assert.isUndefined(tail.summaryDigest);
      const error = yield* service
        .readThread(scope, { threadId: childId, tail: 2, afterPosition: 4 })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
    }).pipe(Effect.provide(makeLayer([]))),
  );

  it.effect(
    "a tail read leaves acknowledgement to the host service; a full read still does it",
    () => {
      const dispatched: Array<OrchestrationV2ServerCommand["type"]> = [];
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.readThread(scope, { threadId: childId, tail: 1 });
        assert.deepEqual(dispatched, []);
        yield* service.readThread(scope, { threadId: childId });
        assert.deepEqual(dispatched, ["delegated_task.completion-delivery.acknowledge"]);
      }).pipe(Effect.provide(makeLayer(dispatched)));
    },
  );

  const finishedRead = { status: "completed", activeRunId: null, latestRunId: childRunId } as const;

  it.effect.each(["summary", "tail"] as const)(
    "a %s read that saw the task's finished run acknowledges its completion delivery",
    (mode) => {
      const dispatched: Array<OrchestrationV2ServerCommand["type"]> = [];
      const input =
        mode === "summary"
          ? { threadId: childId, view: "summary" as const }
          : { threadId: childId, tail: 3 };
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.acknowledgeChildRead(scope, { threadId: childId }, finishedRead);
        // The read saw the child still running, or an earlier run than the one that finished.
        yield* service.acknowledgeChildRead(scope, input, {
          status: "running",
          activeRunId: childRunId,
          latestRunId: childRunId,
        });
        yield* service.acknowledgeChildRead(scope, input, {
          ...finishedRead,
          latestRunId: RunId.make("run:lazy-earlier"),
        });
        assert.deepEqual(dispatched, []);
        yield* service.acknowledgeChildRead(scope, input, finishedRead);
        assert.deepEqual(dispatched, ["delegated_task.completion-delivery.acknowledge"]);
        // The command names the results this check saw, so the orchestrator refuses a newer one.
        const command = sent.at(-1);
        assert.deepEqual(
          command?.type === "delegated_task.completion-delivery.acknowledge"
            ? command.expectedRevision
            : undefined,
          { resultCount: 1, promoted: false },
        );
      }).pipe(Effect.provide(makeLayer(dispatched)));
    },
  );

  it.effect("a summary read through host acknowledges only the remote task it names", () => {
    const dispatched: Array<OrchestrationV2ServerCommand["type"]> = [];
    const remoteTask = {
      ...task,
      childThreadId: null,
      remote: { host: "build-box", threadId: "remote-child", correlationId: "rr-lazy" },
    };
    const remoteChild = ThreadId.make("remote-child");
    const summary = { threadId: remoteChild, view: "summary" as const };
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* service.acknowledgeChildRead(scope, summary, finishedRead);
      yield* service.acknowledgeChildRead(scope, { ...summary, host: "other-box" }, finishedRead);
      yield* service.acknowledgeChildRead(
        scope,
        { ...summary, host: "build-box" },
        { ...finishedRead, status: "running", activeRunId: RunId.make("run:remote") },
      );
      assert.deepEqual(dispatched, []);
      yield* service.acknowledgeChildRead(scope, { ...summary, host: "build-box" }, finishedRead);
      assert.deepEqual(dispatched, ["delegated_task.completion-delivery.acknowledge"]);
    }).pipe(
      Effect.provide(
        layerFor({
          getThreadRecords: () => Effect.succeed(parentProjection([remoteTask])),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return {} as never;
            }),
        }),
      ),
    );
  });
});

describe("goat_thread_read through HostThreadsMcpService", () => {
  const childId = ThreadId.make("thread:lazy-host-child");
  const observed = {
    status: "completed",
    activeRunId: null,
    latestRunId: RunId.make("run:lazy-host"),
  } as const;
  const read = (failResult: boolean, input: OrchestratorMcpThreadReadInput) => {
    const acknowledged: Array<unknown> = [];
    const layer = HostThreadsMcpService.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadResultService.ThreadResultService)({
          forRun: () =>
            failResult
              ? Effect.fail(new ThreadResultService.ThreadResultError({ reason: "storage" }))
              : Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(RemoteReportService.RemoteReportService)({})),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
      ),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          readThread: () =>
            Effect.succeed({
              thread: observed,
              recentRuns: [],
              items: [],
              nextPosition: null,
              hasMore: false,
            } as unknown as OrchestratorMcpThreadReadResult),
          acknowledgeChildRead: (_scope, acknowledgedInput, seen) =>
            Effect.sync(() => void acknowledged.push([acknowledgedInput, seen])),
        }),
      ),
      Layer.provide(layerNoFleetSync),
      Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
      Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    );
    return Effect.gen(function* () {
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      const result = yield* service.readThread(scope, input).pipe(Effect.result);
      return { result, acknowledged };
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    { view: "summary" as const, acknowledges: true },
    { tail: 2, acknowledges: true },
    { limit: 2, acknowledges: false },
  ])("a read acknowledges a child's completion only for summary and tail: %o", (testCase) =>
    Effect.gen(function* () {
      const { acknowledges, ...rest } = testCase;
      const input = { threadId: childId, ...rest };
      const { result, acknowledged } = yield* read(false, input);
      assert.equal(result._tag, "Success");
      assert.deepEqual(acknowledged, acknowledges ? [[input, observed]] : []);
    }),
  );

  it.effect("a summary read whose result fails leaves the completion delivery open", () =>
    Effect.gen(function* () {
      const { result, acknowledged } = yield* read(true, { threadId: childId, view: "summary" });
      assert.equal(result._tag, "Failure");
      assert.deepEqual(acknowledged, []);
    }),
  );
});

it.layer(layerOrchestrator)("acknowledging a task the caller saw", (it) => {
  it.effect("leaves a result recorded after the read for its completion wake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:lazy-ack-parent");
      const childThreadId = ThreadId.make("thread:lazy-ack-child");
      const seededTaskId = NodeId.make("node:lazy-ack-task");
      // One clock reading for every write: the newer result lands in the same millisecond.
      const at = yield* DateTime.now;
      yield* seedParentWithTerminalTask({
        threadId,
        runId: RunId.make("run:lazy-ack-parent"),
        taskId: seededTaskId,
        projectId: ProjectId.make("project:lazy-ack"),
        rootNodeId: NodeId.make("root"),
        deliveryState: "delivered",
        now: at,
      });
      const task = () =>
        orchestrator.getThreadProjection(threadId).pipe(Effect.map((p) => p.subagents[0]!));
      const result = (ordinal: number) =>
        sink.write({
          commandId: CommandId.make(`command:lazy-ack-result-${ordinal}`),
          events: [
            {
              id: EventId.make(`event:lazy-ack-transfer-${ordinal}`),
              type: "context-transfer.created",
              threadId,
              occurredAt: at,
              payload: {
                id: ContextTransferId.make(`transfer:lazy-ack-${ordinal}`),
                type: "subagent_result",
                sourceThreadId: childThreadId,
                targetThreadId: threadId,
                sourcePoint: { threadId: childThreadId, runId: RunId.make(`run:child-${ordinal}`) },
                basePoint: null,
                sourceProviderInstanceId: null,
                targetProviderInstanceId: null,
                targetRunId: null,
                status: "consumed",
                resolution: null,
                createdBy: "system",
                error: null,
                createdAt: at,
                updatedAt: at,
                consumedAt: at,
              },
            },
          ],
        });
      const acknowledge = (resultCount: number, id: string) =>
        orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(id),
          parentThreadId: threadId,
          taskId: seededTaskId,
          observedByRunId: null,
          expectedRevision: { resultCount, promoted: false },
        });
      const seeded = yield* task();
      yield* sink.write({
        commandId: CommandId.make("command:lazy-ack-child"),
        events: [
          {
            id: EventId.make("event:lazy-ack-child"),
            type: "subagent.updated",
            threadId,
            runId: RunId.make("run:lazy-ack-parent"),
            nodeId: seededTaskId,
            driver: seeded.driver,
            occurredAt: at,
            payload: { ...seeded, childThreadId },
          },
        ],
      });
      yield* result(1);
      // The read saw one result; a second arrives before its acknowledgement.
      yield* result(2);
      yield* acknowledge(1, "command:lazy-ack-stale");
      assert.equal((yield* task()).completionDelivery?.state, "delivered");
      yield* acknowledge(2, "command:lazy-ack-current");
      assert.equal((yield* task()).completionDelivery?.state, "acknowledged");
    }),
  );
});
