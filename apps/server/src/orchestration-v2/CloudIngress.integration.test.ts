import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "../mcp/ThreadReplicaService.ts";
import { assert, it } from "@effect/vitest";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  EnvironmentId,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatusResult,
  type Project,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import {
  CursorCloudSdk,
  CURSOR_CLOUD_DRIVER_KIND,
  makeCursorCloudAdapter,
  type CloudAgent,
  type CloudRun,
} from "@goat/provider-cursor/testing";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpServer, McpSchema } from "effect/ai";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterTurnStartError,
} from "@goat/provider-core/server/ProviderAdapter";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import { CLOUD_DELIVERY_REJECTED_CODE } from "@goat/provider-core/server/cloudTask";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as RuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as EffectWorker from "./EffectWorker.ts";
import * as CloudSource from "./CloudTaskSourceService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as RemoteDispatch from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatches from "../mcp/LaunchWatchService.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeFakeCloudAdapter } from "./testkit/FakeCloudAdapter.ts";

const cloudMcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-ingress-ci", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-ingress-ci", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const decodeTaskCancelResult = Schema.decodeUnknownSync(OrchestratorMcpTaskCancelResult);
const decodeThreadStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeTaskStatus = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);

function assertCloudResultItem(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  const results = projection.turnItems.filter(
    (item) => item.runId === runId && item.type === "assistant_message",
  );
  assert.equal(results.length, 1);
  const result = results[0]!;
  assert.equal(result.type, "assistant_message");
  if (result.type !== "assistant_message") throw new Error("Missing assistant result");
  assert.equal(result.id, `turn-item:cloud-result:${runId}`);
  assert.equal(result.messageId, `message:cloud-result:${runId}`);
  assert.equal(result.status, "completed");
  assert.isFalse(result.streaming);
  const messages = projection.messages.filter((message) => message.id === result.messageId);
  assert.equal(messages.length, 1);
  assert.equal(result.text, messages[0]!.text);
  const visible = projection.visibleTurnItems.filter((row) => row.sourceItemId === result.id);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0]!.item, result);
  const run = projection.runs.find((candidate) => candidate.id === runId)!;
  assert.isAbove(result.ordinal, run.ordinal * 1_000_000);
  return result;
}

function cloudDelegationMcpLayer<A, E, R>(
  runtime: Layer.Layer<A, E, R>,
  registry: Layer.Layer<Registry.ProviderAdapterRegistryV2>,
  projects: Layer.Layer<Projects.ProjectService>,
) {
  return McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(runtime),
    Layer.provide(registry),
    Layer.provide(projects),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(Secrets.SecretRequests)({})),
    Layer.provide(Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({})),
    Layer.provide(Layer.mock(SshDispatch.SshRemoteDispatch)({})),
    Layer.provide(
      Layer.mock(LaunchWatches.LaunchWatchService)({ find: () => Effect.succeed(null) }).pipe(
        Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
      ),
    ),
    Layer.provide(
      ThreadResults.layer.pipe(
        Layer.provide(runtime),
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
}

const seedCloudDelegation = Effect.fn("cloudTest.seedCloudDelegation")(function* (
  prefix: string,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  task: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const parentId = ThreadId.make(`thread:${prefix}-parent`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:${prefix}-parent`),
    threadId: parentId,
    projectId,
    title: "Parent",
    modelSelection: { instanceId, model: "fake" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "dev",
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:${prefix}-parent-run`),
    threadId: parentId,
    messageId: MessageId.make(`message:${prefix}-parent`),
    text: "Delegate",
    attachments: [],
    dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root", branch: "dev" } },
    createdBy: "user",
    creationSource: "web",
  });
  const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:${prefix}-parent-running`),
        type: "run.updated",
        threadId: parentId,
        occurredAt: now,
        payload: { ...parentRun, status: "running", startedAt: now },
      },
    ],
  });
  const delegation = yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`command:${prefix}-delegate`),
    parentThreadId: parentId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task,
    modelSelection: { instanceId, model: "fake" },
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  return { parentId, delegation, now };
});

it.effect.each([
  { providerText: "same", projectFolder: false },
  { providerText: "different", projectFolder: false },
  { providerText: "same", projectFolder: true },
  { providerText: "different", projectFolder: true },
] as const)(
  "cloud finalization reuses only $providerText provider assistant text (projectFolder=$projectFolder)",
  ({ providerText, projectFolder }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCloudAdapter();
      const fs = yield* FileSystem.FileSystem;
      const outputWorktree = projectFolder
        ? yield* fs.makeTempDirectoryScoped({ prefix: "cloud-output-" })
        : null;
      const capabilities = yield* fake.adapter.getCapabilities();
      const sourceRestriction = projectFolder ? "project-folder" : "published-ref";
      const adapter = {
        ...fake.adapter,
        getCapabilities: () =>
          Effect.succeed({
            ...capabilities,
            sessions: { ...capabilities.sessions, sourceRestriction },
          }),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
      const projectId = ProjectId.make("project:cloud-result");
      const runtime = layerWithRegistry(
        { name: `cloud-result-${providerText}-${projectFolder}` },
        Registry.layerFromAdapters([adapter]),
        {
          runEffectWorker: false,
          projects: Layer.mock(Projects.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as Project)),
          }),
          cloudSources: Layer.succeed(CloudSource.CloudTaskSourceService, {
            resolve: (input) => {
              assert.equal(input.cwd, "/repo");
              assert.equal(input.restriction, sourceRestriction);
              return Effect.succeed({
                source: { repository: "https://github.com/acme/repo", branch: "dev" },
                launchSource: { cwd: input.cwd, restriction: sourceRestriction },
                localChangesExcluded: !projectFolder,
                ...(projectFolder ? { localChangesIncluded: true } : {}),
              });
            },
          }),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:cloud-result");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:cloud-result-thread"),
          threadId,
          projectId,
          title: "Cloud result",
          modelSelection: { instanceId: fake.adapter.instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: outputWorktree,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:cloud-result-run"),
          threadId,
          messageId: MessageId.make("message:cloud-result-user"),
          text: "Run in the cloud",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const input = yield* Ref.get(fake.current);
        assert.isNotNull(input);
        if (input === null) throw new Error("Cloud adapter did not start");
        assert.equal(
          input.providerThread.cloudTask?.localChangesIncluded,
          projectFolder ? true : undefined,
        );
        assert.deepEqual(input.cloudLaunchSource, { cwd: "/repo", restriction: sourceRestriction });
        const accepted = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          accepted.providerThreads[0]?.cloudTask?.localChangesIncluded,
          projectFolder ? true : undefined,
        );
        const itemId = TurnItemId.make("turn-item:provider-result");
        const now = yield* DateTime.now;
        const finalText =
          "Completed fake task\n\n- Pull request: https://github.com/acme/repo/pull/1\n- Branch: `agent/fix`\n- Cloud task: https://example.com/tasks/1";
        const providerItem = {
          id: itemId,
          type: "assistant_message" as const,
          threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerThreadId: input.providerThread.id,
          providerTurnId: ProviderTurnId.make(`provider-turn:fake-cloud:${input.attemptId}`),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId: MessageId.make("message:provider-result"),
          text: providerText === "same" ? finalText : "I started working on the task.",
          attachments: [],
          streaming: false,
        };
        const itemPersisted = yield* sink.stream({ threadId, eventType: "turn-item.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" && stored.event.payload.id === itemId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* fake.publish({
          type: "turn_item.updated",
          driver: fake.adapter.driver,
          turnItem: providerItem,
        });
        yield* Fiber.join(itemPersisted);
        const completed = yield* sink.stream({ threadId, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === input.runId &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* fake.finish();
        yield* Fiber.join(completed);
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.providerThreads[0]?.cloudTask?.localChangesIncluded,
          projectFolder ? true : undefined,
        );
        const assistants = projection.turnItems.filter((item) => item.type === "assistant_message");
        assert.equal(assistants.length, providerText === "same" ? 1 : 2);
        const results = assistants.filter(
          (item) => item.type === "assistant_message" && item.text === finalText,
        );
        assert.equal(results.length, 1);
        assert.equal(
          results[0]!.id,
          providerText === "same" ? itemId : `turn-item:cloud-result:${input.runId}`,
        );
        assert.deepEqual(
          projection.visibleTurnItems.find((row) => row.sourceItemId === results[0]!.id)?.item,
          results[0],
        );
        assert.equal(
          projection.messages.find(
            (message) => message.id === `message:cloud-result:${input.runId}`,
          )?.text,
          finalText,
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reattaches a fully running SQLite cloud crash snapshot once without resubmission", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const previous = yield* makeFakeCloudAdapter(true, instanceId);
    const resumed = yield* makeFakeCloudAdapter(true, instanceId);
    let opens = 0;
    const adapter = {
      ...resumed.adapter,
      openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
        (++opens === 1 ? previous : resumed).adapter.openSession(input),
    };
    const runtime = layerWithRegistry(
      { name: "cloud-crash-recovery" },
      Registry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    );
    const recovery = RuntimeRecovery.layer.pipe(
      Layer.provideMerge(runtime),
      Layer.provideMerge(CommandReceipts.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      Layer.provide(IdAllocator.layer),
      Layer.provide(ServerSettings.layerTest()),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const manager = yield* ProviderSessions.ProviderSessionManagerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      const threadId = ThreadId.make("thread:cloud-crash");
      const modelSelection = { instanceId, model: "fake" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:cloud-crash-thread"),
        threadId,
        projectId: ProjectId.make("project:cloud-crash"),
        title: "Recover accepted cloud work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "dev",
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:cloud-crash-run"),
        threadId,
        messageId: MessageId.make("message:cloud-crash"),
        text: "Already accepted remotely",
        attachments: [],
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        createdBy: "user",
        creationSource: "web",
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const attempt = initial.attempts[0]!;
      const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
      const providerThread = initial.providerThreads[0]!;
      const providerTurnId = ProviderTurnId.make(`provider-turn:fake-cloud:${attempt.id}`);
      const session = yield* manager.open({
        threadId,
        providerSessionId: providerThread.providerSessionId!,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
      const now = yield* DateTime.now;
      // Persist the crash boundary after remote acceptance, without executing a submission.
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:cloud-crash-run"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:cloud-crash-attempt"),
            type: "run-attempt.updated",
            threadId,
            occurredAt: now,
            payload: { ...attempt, providerTurnId, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:cloud-crash-root"),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: { ...root, providerTurnId, status: "running", startedAt: now },
          },
          {
            id: EventId.make("event:cloud-crash-turn"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId: providerThread.id,
              nodeId: root.id,
              runAttemptId: attempt.id,
              nativeTurnRef: {
                driver: adapter.driver,
                nativeId: "remote-task-1",
                strength: "strong",
              },
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:cloud-crash-session"),
            type: "provider-session.updated",
            threadId,
            occurredAt: now,
            payload: session.providerSession,
          },
          {
            id: EventId.make("event:cloud-crash-task"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...providerThread,
              status: "active",
              nativeThreadRef: {
                driver: adapter.driver,
                nativeId: "native-session-1",
                strength: "strong",
              },
              cloudTask: {
                taskId: "remote-task-1",
                status: "running",
                tracking: "live",
                source: {
                  repository: "https://github.com/acme/repo",
                  branch: "dev",
                  sha: "a".repeat(40),
                },
                localChangesExcluded: true,
                updatedAt: DateTime.formatIso(now),
              },
            },
          },
        ],
      });
      yield* manager.shutdown;
      assert.isTrue(Option.isNone(yield* manager.get(session.providerSessionId)));
      assert.equal(yield* Ref.get(previous.detaches), 1);
      const crash = yield* orchestrator.getThreadProjection(threadId);
      const sequence = yield* sink.latestSequence({ threadId });
      const summary = yield* (yield* RuntimeRecovery.ProviderRuntimeRecoveryService).reconcile(
        "startup",
      );
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(yield* sink.latestSequence({ threadId }), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), crash);
      const pending = yield* outbox.claimNext({ workerId: "inspect-recovery", leaseDurationMs: 1 });
      const reattach = Option.getOrThrow(pending);
      assert.deepEqual(reattach.request, { type: "provider-turn.reattach", runId: run.id });
      const receipt = Option.getOrThrow(yield* receipts.getByCommandId(reattach.commandId));
      assert.equal(receipt.status, "accepted");
      assert.equal(receipt.resultSequence, sequence);
      assert.equal((yield* outbox.listByCommandId(reattach.commandId)).length, 1);
      assert.deepEqual(
        yield* sink.readByCommandId({ commandId: reattach.commandId }).pipe(Stream.runCollect),
        [],
      );
      yield* outbox.reconcileAfterProcessLoss;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      yield* worker.drain();
      assert.equal(yield* Ref.get(resumed.attachments), 1);
      assert.equal(yield* Ref.get(resumed.submissions), 0);
      assert.equal(yield* Ref.get(resumed.creations), 0);
      assert.equal(yield* Ref.get(previous.submissions), 0);
      assert.equal(yield* Ref.get(resumed.cancellations), 0);
      assert.equal(Option.getOrThrow(yield* outbox.get(reattach.id)).status, "succeeded");
    }).pipe(Effect.provide(recovery));
  }).pipe(Effect.scoped),
);

const cursorSource = {
  repository: "https://github.com/fixture/repo",
  branch: "published",
  sha: "a".repeat(40),
};
// The existing enabled slot avoids making these persistence tests depend on catalog registration.
const cursorInstanceId = ProviderInstanceId.make("codex");
const cursorAgentId = "bc-ingress-fixture";
type CursorRunResult = Awaited<ReturnType<CloudRun["wait"]>>;
type CursorStreamEvent =
  ReturnType<CloudRun["stream"]> extends AsyncGenerator<infer Event, void> ? Event : never;

const makeCursorIngress = Effect.fnUntraced(function* (
  name: string,
  options: {
    blockCreate?: boolean;
    blockSend?: boolean;
    blockResume?: boolean;
    replayTerminal?: boolean;
  } = {},
) {
  const creating = yield* Deferred.make<void>();
  const createGate = Promise.withResolvers<void>();
  const sending = yield* Deferred.make<void>();
  const sendGate = Promise.withResolvers<void>();
  const resuming = yield* Deferred.make<void>();
  const resumeGate = Promise.withResolvers<void>();
  const cancelled = yield* Deferred.make<void>();
  const sourceReads = yield* Ref.make(0);
  const adapterAssistantFinals = yield* Ref.make(0);
  const capturedTerminal =
    yield* Deferred.make<
      Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
    >();
  const replayEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* Effect.addFinalizer(() => Queue.shutdown(replayEvents));
  const runs = yield* Effect.forEach([1, 2], (ordinal) =>
    Effect.gen(function* () {
      const streaming = yield* Deferred.make<void>();
      const finishStream = Promise.withResolvers<void>();
      const firstLookup = yield* Deferred.make<void>();
      const secondLookup = yield* Deferred.make<void>();
      const thirdLookup = yield* Deferred.make<void>();
      let lookupCount = 0;
      let result: CursorRunResult = {
        id: `cursor-run-${ordinal}`,
        status: "finished",
        result: `Completed task ${ordinal}.`,
        git: {
          branches: [
            {
              repoUrl: "github.com/fixture/unrelated",
              branch: "wrong",
              prUrl: "https://github.com/fixture/unrelated/pull/9",
            },
            {
              repoUrl: "github.com/fixture/repo.git",
              branch: `cursor/result-${ordinal}`,
              prUrl: `https://github.com/fixture/repo/pull/${ordinal}`,
            },
          ],
        },
      };
      let status: CloudRun["status"] = "running";
      const stream = vi.fn(() => {
        const iterator: AsyncGenerator<CursorStreamEvent, void> = {
          next: async () => {
            Deferred.doneUnsafe(streaming, Effect.void);
            await finishStream.promise;
            return { done: true, value: undefined };
          },
          return: async () => {
            finishStream.resolve();
            return { done: true, value: undefined };
          },
          throw: async (error) => {
            throw error;
          },
          [Symbol.asyncIterator]: () => iterator,
          [Symbol.asyncDispose]: async () => {
            await iterator.return();
          },
        };
        return iterator;
      });
      const native: CloudRun = {
        id: result.id,
        agentId: cursorAgentId,
        createdAt: 1791849600000,
        get status() {
          return status;
        },
        stream,
        wait: async () => result,
      };
      return {
        native,
        stream,
        streaming,
        firstLookup,
        secondLookup,
        thirdLookup,
        lookup: async () => {
          lookupCount++;
          Deferred.doneUnsafe(lookupCount === 1 ? firstLookup : secondLookup, Effect.void);
          if (lookupCount >= 3) Deferred.doneUnsafe(thirdLookup, Effect.void);
          return native;
        },
        finish: (outcome: CursorRunResult["status"] = "finished") =>
          Effect.sync(() => {
            result = { ...result, status: outcome };
            status = outcome;
            finishStream.resolve();
          }),
      };
    }),
  );
  const close = vi.fn();
  let sendCount = 0;
  const send = vi.fn<CloudAgent["send"]>(async () => {
    const run = runs[sendCount++]!.native;
    Deferred.doneUnsafe(sending, Effect.void);
    if (options.blockSend) await sendGate.promise;
    return run;
  });
  const agent = { agentId: cursorAgentId, send, close };
  const create = vi.fn<CursorCloudSdk["Service"]["create"]>(async () => {
    Deferred.doneUnsafe(creating, Effect.void);
    if (options.blockCreate) await createGate.promise;
    return agent;
  });
  const resume = vi.fn<CursorCloudSdk["Service"]["resume"]>(async () => {
    Deferred.doneUnsafe(resuming, Effect.void);
    if (options.blockResume) await resumeGate.promise;
    return agent;
  });
  const getRun = vi.fn<CursorCloudSdk["Service"]["getRun"]>(async (id) => {
    const run = runs.find((candidate) => candidate.native.id === id);
    if (!run) throw new Error("Unexpected fixture run");
    return run.lookup();
  });
  const cancelRun = vi.fn<CursorCloudSdk["Service"]["cancelRun"]>(async () => {
    Deferred.doneUnsafe(cancelled, Effect.void);
  });
  const sdk = CursorCloudSdk.of({
    create,
    resume,
    getRun,
    cancelRun,
    checkAccess: () => Effect.void,
    readModels: () => Effect.succeed([]),
  });
  const adapter = yield* makeCursorCloudAdapter(
    cursorInstanceId,
    Effect.succeed("fixture-key"),
  ).pipe(Effect.provideService(CursorCloudSdk, sdk), Effect.provide(IdAllocator.layer));
  // Observe real adapter delivery: shared finalization owns the ordinary result item.
  const observedAdapter = {
    ...adapter,
    openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
      adapter.openSession(input).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          events: runtime.events.pipe(
            Stream.tap((event) =>
              (event.type === "message.updated" &&
                event.message.role === "assistant" &&
                !event.message.streaming) ||
              (event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                !event.turnItem.streaming)
                ? Ref.update(adapterAssistantFinals, (count) => count + 1)
                : Effect.void,
            ),
          ),
        })),
      ),
  };
  // Replay a captured event at the existing adapter stream boundary; all runtime methods stay real.
  const registeredAdapter = options.replayTerminal
    ? {
        ...observedAdapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          observedAdapter.openSession(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              events: Stream.merge(
                runtime.events.pipe(
                  Stream.tap((event) =>
                    event.type === "turn.terminal"
                      ? Deferred.succeed(capturedTerminal, event)
                      : Effect.void,
                  ),
                ),
                Stream.fromQueue(replayEvents),
              ),
            })),
          ),
      }
    : observedAdapter;
  const database = SqlitePersistence.layerMemory;
  const runtime = layerWithRegistry({ name }, Registry.layerFromAdapters([registeredAdapter]), {
    databaseLayer: database,
    runEffectWorker: false,
    projects: Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          workspaceRoot: process.cwd(),
          defaultModelSelection: { instanceId: cursorInstanceId, model: "auto" },
        } as Project),
    }),
    cloudSources: Layer.succeed(CloudSource.CloudTaskSourceService, {
      resolve: (input) =>
        Ref.updateAndGet(sourceReads, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Effect.succeed({
                  source: cursorSource,
                  launchSource: { cwd: input.cwd, restriction: "published-ref" as const },
                  localChangesExcluded: true,
                })
              : Effect.die("Local branch was deleted; follow-up must reuse the saved source"),
          ),
        ),
    }),
  });
  const recovery = Recovery.layer.pipe(
    Layer.provide(runtime),
    Layer.provide(IdAllocator.layer),
    Layer.provide(ServerSettings.layerTest()),
  );
  return {
    layer: Layer.mergeAll(runtime, recovery, database, IdAllocator.layer),
    creating,
    allowCreate: Effect.sync(() => createGate.resolve()),
    sending,
    allowSend: Effect.sync(() => sendGate.resolve()),
    resuming,
    allowResume: Effect.sync(() => resumeGate.resolve()),
    cancelled,
    runs,
    sourceReads,
    adapterAssistantFinals,
    create,
    resume,
    send,
    getRun,
    cancelRun,
    close,
    capturedTerminal,
    replayTerminal: (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(replayEvents, event).pipe(Effect.asVoid),
  };
});

const createCursorThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:cursor-ingress"),
    title: "Cursor Cloud integration",
    modelSelection: { instanceId: cursorInstanceId, model: "auto" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "deleted-local-branch",
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const dispatchCursorMessage = Effect.fnUntraced(function* (
  threadId: ThreadId,
  ordinal: number,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
) {
  return yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:cursor:${threadId}:${ordinal}`),
    threadId,
    messageId: MessageId.make(`message:cursor:${threadId}:${ordinal}`),
    text: `Task ${ordinal}`,
    attachments: [],
    dispatchMode,
    createdBy: "user",
    creationSource: "web",
  });
});

const awaitCursorRun = Effect.fnUntraced(function* (
  threadId: ThreadId,
  runId: RunId,
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted",
) {
  return yield* (yield* Orchestrator.OrchestratorV2)
    .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === runId &&
          stored.event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runDrain,
    );
});

const awaitCursorTurn = Effect.fnUntraced(function* (
  threadId: ThreadId,
  attemptId: RunAttemptId,
  afterSequence?: number,
) {
  yield* (yield* Orchestrator.OrchestratorV2)
    .streamStoredEventsFrom({
      threadId,
      eventType: "provider-turn.updated",
      ...(afterSequence === undefined ? {} : { afterSequence }),
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.runAttemptId === attemptId &&
          stored.event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
    );
});

function assertCursorResult(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  ordinal: number,
  status = "completed",
) {
  const run = projection.runs.find((candidate) => candidate.id === runId)!;
  assert.equal(run.status, status);
  assert.equal(
    projection.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.status,
    status,
  );
  assert.equal(projection.nodes.find((node) => node.id === run.rootNodeId)?.status, status);
  const results = projection.messages.filter(
    (message) => message.runId === runId && message.role === "assistant",
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, `message:cloud-result:${runId}`);
  assert.include(results[0]!.text, `Completed task ${ordinal}.`);
  assert.include(results[0]!.text, `https://github.com/fixture/repo/pull/${ordinal}`);
  assert.include(results[0]!.text, `cursor/result-${ordinal}`);
  assert.notInclude(results[0]!.text, "unrelated");
  assert.isFalse(results[0]!.streaming);
  // The real SQLite read must also contain the item consumed by client timelines.
  const assistantItems = projection.turnItems
    .filter((item) => item.type === "assistant_message")
    .filter((item) => item.runId === runId);
  assert.equal(assistantItems.length, 1, "one persisted assistant result item per run");
  const item = assistantItems[0]!;
  assert.equal(item.id, `turn-item:cloud-result:${runId}`);
  assert.equal(item.messageId, results[0]!.id);
  assert.equal(item.threadId, projection.thread.id);
  assert.equal(item.nodeId, run.rootNodeId);
  assert.equal(item.text, results[0]!.text);
  assert.include(item.text, `Completed task ${ordinal}.`);
  assert.include(item.text, `https://github.com/fixture/repo/pull/${ordinal}`);
  assert.include(item.text, `cursor/result-${ordinal}`);
  assert.notInclude(item.text, "unrelated");
  assert.isFalse(item.streaming);
  assert.isNotNull(item.completedAt);
  if (status === "completed") assert.equal(item.status, "completed");
  const visibleResults = projection.visibleTurnItems.filter(
    (row) => row.item.type === "assistant_message" && row.item.runId === runId,
  );
  assert.equal(visibleResults.length, 1, "one ordinary assistant result in the client timeline");
  assert.equal(visibleResults[0]!.sourceItemId, item.id);
  assert.equal(visibleResults[0]!.sourceThreadId, projection.thread.id);
  assert.deepEqual(visibleResults[0]!.item, item);
  assert.equal(projection.checkpointScopes.length, 0);
  return { message: results[0]!, item, visible: visibleResults[0]! };
}

const seedCursorAccepted = Effect.fnUntraced(function* (
  threadId: ThreadId,
  ordinal: number,
  taskStatus: NonNullable<
    OrchestrationV2ThreadProjection["providerThreads"][number]["cloudTask"]
  >["status"] = "running",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const manager = yield* ProviderSessions.ProviderSessionManagerV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const before = yield* orchestrator.getThreadProjection(threadId);
  const run = before.runs.find((candidate) => candidate.ordinal === ordinal)!;
  const attempt = before.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
  const root = before.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
  const providerThread = before.providerThreads[0]!;
  const providerSessionId =
    providerThread.providerSessionId ??
    (yield* ids.allocate.providerSession({ threadId, providerInstanceId: cursorInstanceId }));
  const runtime = yield* manager.open({
    threadId,
    providerSessionId,
    modelSelection: { instanceId: cursorInstanceId, model: "auto" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
  });
  const now = yield* DateTime.now;
  // Distinct from both the SDK createdAt and the restart clock.
  const startedAt = DateTime.makeUnsafe("2026-10-10T00:00:00.000Z");
  const task = {
    taskId: `cursor-run-${ordinal}`,
    acceptedAppRunId:
      taskStatus === "submitting" ? RunId.make("run:cursor-previous-prompt") : run.id,
    status: taskStatus,
    tracking: "live" as const,
    source: cursorSource,
    localChangesExcluded: true,
    url: `https://cursor.com/agents/${cursorAgentId}`,
    updatedAt: DateTime.formatIso(now),
    ...(["succeeded", "failed", "cancelled"].includes(taskStatus)
      ? {
          summary: `Completed task ${ordinal}.`,
          branch: `cursor/result-${ordinal}`,
          prUrl: `https://github.com/fixture/repo/pull/${ordinal}`,
        }
      : {}),
  };
  yield* sink.write({
    events: [
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: runtime.providerSession,
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          providerSessionId,
          driver: CURSOR_CLOUD_DRIVER_KIND,
          status: "active",
          cloudTask: task,
          nativeThreadRef: {
            driver: CURSOR_CLOUD_DRIVER_KIND,
            nativeId: cursorAgentId,
            strength: "strong",
          },
          lastRunOrdinal: run.ordinal,
        },
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt },
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: { ...attempt, status: "running", startedAt, nativeThreadId: cursorAgentId },
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...root, status: "running", startedAt },
      },
    ],
  });
  // Drop manager-owned observation while retaining the real SQLite snapshot.
  yield* manager.shutdown;
  return { run, attempt, root, task, startedAt, providerThread, providerSessionId };
});

it.effect.each([false, true])(
  "Cursor Cloud manager-owned restore survives idle timeout and releases on shutdown=%s",
  (shutdown) =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress(`cursor-restored-lifecycle-${shutdown}`);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const manager = yield* ProviderSessions.ProviderSessionManagerV2;
        const threadId = ThreadId.make(`thread:cursor-restored-lifecycle-${shutdown}`);
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, {
          type: "defer_start",
          workspaceStrategy: { type: "root" },
        });
        const saved = yield* seedCursorAccepted(threadId, 1);
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        yield* worker.drain();
        yield* awaitCursorTurn(threadId, saved.attempt.id);
        yield* Deferred.await(h.runs[0]!.secondLookup);
        const attached = yield* orchestrator.getThreadProjection(threadId);
        const sessionId = attached.providerThreads[0]!.providerSessionId!;
        const loaded = Option.getOrThrow(yield* manager.get(sessionId));
        // layerWithRegistry uses the real manager's configured default of 30 minutes.
        yield* TestClock.adjust("31 minutes");
        assert.strictEqual(Option.getOrThrow(yield* manager.get(sessionId)), loaded);
        yield* Deferred.await(h.runs[0]!.thirdLookup);
        const running = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(running.runs[0]?.status, "running");
        assert.equal(running.providerThreads[0]?.cloudTask?.status, "running");
        assert.equal(h.close.mock.calls.length, 0);
        for (const [id, options] of h.getRun.mock.calls) {
          assert.equal(id, "cursor-run-1");
          assert.equal(options.agentId, cursorAgentId);
          assert.equal(options.runtime, "cloud");
        }
        if (shutdown) {
          yield* manager.shutdown;
          assert.isTrue(Option.isNone(yield* manager.get(sessionId)));
          const detached = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            detached.providerThreads[0]?.cloudTask,
            running.providerThreads[0]?.cloudTask,
          );
          assert.deepEqual(detached.runs[0], running.runs[0]);
          assert.deepEqual(detached.attempts[0], running.attempts[0]);
          assert.deepEqual(
            detached.nodes.find((node) => node.id === saved.root.id),
            running.nodes.find((node) => node.id === saved.root.id),
          );
          const lookups = h.getRun.mock.calls.length;
          yield* TestClock.adjust("15 seconds");
          assert.equal(h.getRun.mock.calls.length, lookups);
          assert.equal(
            detached.messages.filter((message) => message.role === "assistant").length,
            0,
          );
        } else {
          const beforeTerminal = yield* orchestrator.getThreadEventSequence(threadId);
          yield* h.runs[0]!.finish();
          yield* TestClock.adjust("15 seconds");
          yield* awaitCursorRun(threadId, saved.run.id, "completed");
          yield* worker.drain();
          assertCursorResult(yield* orchestrator.getThreadProjection(threadId), saved.run.id, 1);
          const released = yield* orchestrator
            .streamStoredEventsFrom({
              threadId,
              afterSequence: beforeTerminal,
              eventType: "provider-session.updated",
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-session.updated" &&
                  stored.event.payload.id === sessionId &&
                  stored.event.payload.status === "stopped",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
          yield* TestClock.adjust("31 minutes");
          yield* Fiber.join(released);
          assert.isTrue(Option.isNone(yield* manager.get(sessionId)));
        }
        assert.equal(h.create.mock.calls.length, 0);
        assert.equal(h.resume.mock.calls.length, 0);
        assert.equal(h.send.mock.calls.length, 0);
        assert.equal(h.cancelRun.mock.calls.length, 0);
        assert.equal(h.runs[0]!.stream.mock.calls.length, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "Cursor Cloud duplicate adapter terminal delivery leaves one result and settled rows unchanged",
  () =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress("cursor-duplicate-terminal", { replayTerminal: true });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const manager = yield* ProviderSessions.ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread:cursor-duplicate-terminal");
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, { type: "start_immediately" });
        yield* worker.drain();
        yield* Deferred.await(h.runs[0]!.streaming);
        const accepted = yield* orchestrator.getThreadProjection(threadId);
        const run = accepted.runs[0]!;
        yield* awaitCursorTurn(threadId, run.activeAttemptId!);
        const runtime = Option.getOrThrow(
          yield* manager.get(accepted.providerThreads[0]!.providerSessionId!),
        );
        const subscription = yield* runtime.subscribeEvents!;
        const deliveries = yield* subscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* h.runs[0]!.finish();
        const terminal = yield* Deferred.await(h.capturedTerminal);
        yield* awaitCursorRun(threadId, run.id, "completed");
        yield* worker.drain();
        const beforeDuplicate = yield* orchestrator.getThreadProjection(threadId);
        assertCursorResult(beforeDuplicate, run.id, 1);
        const beforeSequence = yield* orchestrator.getThreadEventSequence(threadId);
        // A refinalization would now produce different completedAt/updatedAt timestamps.
        yield* TestClock.adjust("1 second");
        yield* h.replayTerminal(terminal);
        assert.deepEqual(yield* Fiber.join(deliveries), [terminal, terminal]);
        yield* subscription.close;
        yield* worker.drain();
        const afterDuplicate = yield* orchestrator.getThreadProjection(threadId);
        assertCursorResult(afterDuplicate, run.id, 1);
        assert.deepEqual(afterDuplicate.runs, beforeDuplicate.runs);
        assert.deepEqual(afterDuplicate.attempts, beforeDuplicate.attempts);
        assert.deepEqual(afterDuplicate.nodes, beforeDuplicate.nodes);
        assert.deepEqual(afterDuplicate.messages, beforeDuplicate.messages);
        assert.deepEqual(afterDuplicate.turnItems, beforeDuplicate.turnItems);
        assert.deepEqual(afterDuplicate.visibleTurnItems, beforeDuplicate.visibleTurnItems);
        assert.equal(yield* orchestrator.getThreadEventSequence(threadId), beforeSequence);
        assert.equal(yield* Ref.get(h.adapterAssistantFinals), 0);
        assert.equal(h.create.mock.calls.length, 1);
        assert.equal(h.send.mock.calls.length, 1);
        assert.equal(h.cancelRun.mock.calls.length, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect.each(["succeeded", "failed", "cancelled"] as const)(
  "Cursor Cloud recovery settles saved %s metadata exactly once without a submission or cancellation",
  (taskStatus) =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress(`cursor-terminal-recovery-${taskStatus}`);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
        const threadId = ThreadId.make(`thread:cursor-terminal-recovery-${taskStatus}`);
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, {
          type: "defer_start",
          workspaceStrategy: { type: "root" },
        });
        const saved = yield* seedCursorAccepted(threadId, 1, taskStatus);
        yield* h.runs[0]!.finish(
          taskStatus === "succeeded" ? "finished" : taskStatus === "failed" ? "error" : "cancelled",
        );
        yield* recovery.recover;
        yield* worker.drain();
        const status =
          taskStatus === "succeeded"
            ? "completed"
            : taskStatus === "failed"
              ? "failed"
              : "cancelled";
        yield* awaitCursorRun(threadId, saved.run.id, status);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assertCursorResult(settled, saved.run.id, 1, status);
        const turn = settled.providerTurns.find(
          (candidate) => candidate.runAttemptId === saved.attempt.id,
        )!;
        assert.equal(turn.ordinal, 1);
        assert.equal(DateTime.formatIso(turn.startedAt!), DateTime.formatIso(saved.startedAt));
        assert.equal(turn.nativeTurnRef?.nativeId, "cursor-run-1");
        assert.equal(
          turn.id,
          (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CURSOR_CLOUD_DRIVER_KIND,
            nativeTurnId: `${cursorInstanceId}:cursor-run-1`,
          }),
        );
        const lookups = h.getRun.mock.calls.length;
        assert.isAtLeast(lookups, 1);
        for (const [id, options] of h.getRun.mock.calls) {
          assert.equal(id, "cursor-run-1");
          assert.equal(options.agentId, cursorAgentId);
          assert.equal(options.runtime, "cloud");
        }
        yield* recovery.recover;
        yield* worker.drain();
        assertCursorResult(
          yield* orchestrator.getThreadProjection(threadId),
          saved.run.id,
          1,
          status,
        );
        assert.equal(h.getRun.mock.calls.length, lookups);
        assert.equal(h.create.mock.calls.length, 0);
        assert.equal(h.resume.mock.calls.length, 0);
        assert.equal(h.send.mock.calls.length, 0);
        assert.equal(h.cancelRun.mock.calls.length, 0);
        assert.equal(h.runs[0]!.stream.mock.calls.length, 0);
        assert.equal(yield* Ref.get(h.sourceReads), 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "Cursor Cloud recovery marks a submitting crash unknown without reading the prior task or resending",
  () =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress("cursor-submitting-recovery");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:cursor-submitting-recovery");
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, {
          type: "defer_start",
          workspaceStrategy: { type: "root" },
        });
        const saved = yield* seedCursorAccepted(threadId, 1, "submitting");
        yield* recovery.recover;
        yield* worker.drain();
        const firstFailure = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(firstFailure.providerThreads[0]?.cloudTask?.status, "unknown");
        assert.equal(
          firstFailure.turnItems.filter(
            (item) => item.runId === saved.run.id && item.type === "assistant_message",
          ).length,
          0,
          "Recoverable observation failures must not add a final assistant result",
        );
        assert.equal(h.getRun.mock.calls.length, 0);
        // The default worker makes five attempts. Drive the four remaining durable deadlines,
        // never the vendor poll clock: this prompt has no accepted remote run to observe.
        for (const retry of [1, 2, 3, 4]) {
          const due = Option.getOrThrow(yield* worker.nextClaimableAt);
          const now = yield* DateTime.now;
          yield* TestClock.adjust(
            Math.max(0, DateTime.toEpochMillis(due) - DateTime.toEpochMillis(now)),
          );
          yield* worker.drain();
          assert.equal(
            h.getRun.mock.calls.length,
            0,
            `Retry ${retry} must not observe the previous prompt's run`,
          );
          assert.equal(h.create.mock.calls.length, 0);
          assert.equal(h.send.mock.calls.length, 0);
        }
        yield* awaitCursorRun(threadId, saved.run.id, "failed");
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.providerThreads[0]?.cloudTask?.status, "unknown");
        assert.equal(after.providerThreads[0]?.cloudTask?.taskId, saved.task.taskId);
        assert.equal(
          after.providerThreads[0]?.cloudTask?.acceptedAppRunId,
          saved.task.acceptedAppRunId,
        );
        assert.deepEqual(after.providerThreads[0]?.cloudTask?.source, cursorSource);
        assert.equal(after.providerThreads[0]?.nativeThreadRef?.nativeId, cursorAgentId);
        assert.equal(after.attempts[0]?.status, "failed");
        assert.equal(after.nodes.find((node) => node.id === saved.root.id)?.status, "failed");
        const results = after.messages.filter((message) => message.role === "assistant");
        assert.equal(results.length, 1);
        assert.equal(results[0]?.id, `message:cloud-result:${saved.run.id}`);
        assert.include(results[0]!.text, saved.task.url);
        const assistantItems = after.turnItems.filter(
          (item) => item.runId === saved.run.id && item.type === "assistant_message",
        );
        assert.equal(assistantItems.length, 1, "Exhausted recovery must persist an assistant item");
        const item = assistantItems[0]!;
        assert.equal(item.type, "assistant_message");
        if (item.type !== "assistant_message") throw new Error("Missing recovery assistant result");
        assert.equal(item.id, `turn-item:cloud-result:${saved.run.id}`);
        assert.equal(item.messageId, results[0]!.id);
        assert.equal(item.threadId, threadId);
        assert.equal(item.nodeId, saved.root.id);
        assert.equal(item.text, results[0]!.text);
        assert.include(item.text, "remote work may continue");
        assert.include(item.text, saved.task.url);
        assert.equal(item.status, "completed");
        assert.isFalse(item.streaming);
        assert.isNotNull(item.completedAt);
        const visible = after.visibleTurnItems.filter(
          (row) => row.item.runId === saved.run.id && row.item.type === "assistant_message",
        );
        assert.equal(visible.length, 1, "Exhausted recovery must appear in ordinary history");
        assert.equal(visible[0]!.sourceItemId, item.id);
        assert.equal(visible[0]!.sourceThreadId, threadId);
        assert.deepEqual(visible[0]!.item, item);
        yield* recovery.recover;
        yield* worker.drain();
        const repeated = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(repeated.messages, after.messages);
        assert.deepEqual(repeated.turnItems, after.turnItems);
        assert.deepEqual(repeated.visibleTurnItems, after.visibleTurnItems);
        assert.equal(yield* Ref.get(h.adapterAssistantFinals), 0);
        assert.equal(h.getRun.mock.calls.length, 0);
        assert.equal(h.create.mock.calls.length, 0);
        assert.equal(h.resume.mock.calls.length, 0);
        assert.equal(h.send.mock.calls.length, 0);
        assert.equal(h.cancelRun.mock.calls.length, 0);
        assert.equal(h.runs[0]!.stream.mock.calls.length, 0);
        assert.equal(after.checkpointScopes.length, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { scenario: "initial-missing-turn", ordinal: 1, recorded: false, outcome: "cancelled" },
  { scenario: "follow-up-missing-turn", ordinal: 2, recorded: false, outcome: "finished" },
  { scenario: "existing-attempt", ordinal: 1, recorded: true, outcome: "finished" },
] as const)(
  "Cursor Cloud $scenario restores the turn before Stop and trusts authoritative $outcome",
  ({ scenario, ordinal, recorded, outcome }) =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress(`cursor-restored-stop-${scenario}`);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
        const threadId = ThreadId.make(`thread:cursor-restored-stop-${scenario}`);
        yield* createCursorThread(threadId);
        if (ordinal === 2 || recorded) {
          yield* dispatchCursorMessage(threadId, 1, { type: "start_immediately" });
          yield* worker.drain();
          yield* Deferred.await(h.runs[0]!.streaming);
          const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          yield* awaitCursorTurn(threadId, first.activeAttemptId!);
          if (ordinal === 2) {
            yield* h.runs[0]!.finish();
            yield* awaitCursorRun(threadId, first.id, "completed");
            yield* worker.drain();
          }
        }
        if (!recorded)
          yield* dispatchCursorMessage(threadId, ordinal, {
            type: "defer_start",
            workspaceStrategy: { type: "root" },
          });
        const saved = yield* seedCursorAccepted(threadId, ordinal);
        const creates = h.create.mock.calls.length;
        const sends = h.send.mock.calls.length;
        const streams = h.runs[ordinal - 1]!.stream.mock.calls.length;
        const beforeRecovery = yield* orchestrator.getThreadEventSequence(threadId);
        yield* recovery.recover;
        yield* worker.drain();
        yield* awaitCursorTurn(threadId, saved.attempt.id, beforeRecovery);
        yield* Deferred.await(h.runs[ordinal - 1]!.secondLookup);
        const attached = yield* orchestrator.getThreadProjection(threadId);
        const turn = attached.providerTurns.find(
          (candidate) => candidate.runAttemptId === saved.attempt.id,
        )!;
        assert.equal(turn.ordinal, ordinal);
        assert.isAbove(turn.ordinal, 0);
        assert.equal(DateTime.formatIso(turn.startedAt!), DateTime.formatIso(saved.startedAt));
        assert.equal(turn.nativeTurnRef?.nativeId, `cursor-run-${ordinal}`);
        assert.equal(
          attached.providerTurns.filter((candidate) => candidate.runAttemptId === saved.attempt.id)
            .length,
          1,
        );
        if (ordinal === 2)
          assert.deepEqual(
            attached.providerTurns.map((candidate) => candidate.ordinal).sort(),
            [1, 2],
          );
        assert.equal(h.create.mock.calls.length, creates);
        assert.equal(h.send.mock.calls.length, sends);
        assert.equal(h.runs[ordinal - 1]!.stream.mock.calls.length, streams);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`command:stop:${threadId}`),
          threadId,
          runId: saved.run.id,
          holdQueue: true,
        });
        const stopping = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(h.cancelled);
        assert.equal(h.cancelRun.mock.calls.length, 1);
        assert.equal(h.cancelRun.mock.calls[0]![0], `cursor-run-${ordinal}`);
        assert.equal(h.cancelRun.mock.calls[0]![1].agentId, cursorAgentId);
        assert.equal(h.cancelRun.mock.calls[0]![1].runtime, "cloud");
        const requested = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          requested.runs.find((candidate) => candidate.id === saved.run.id)?.status,
          "running",
        );
        assert.equal(requested.providerThreads[0]?.cloudTask?.status, "running");
        assert.equal(
          requested.messages.filter(
            (message) => message.id === `message:cloud-result:${saved.run.id}`,
          ).length,
          0,
        );
        yield* h.runs[ordinal - 1]!.finish(outcome);
        yield* TestClock.adjust("15 seconds");
        const status = outcome === "cancelled" ? "interrupted" : "completed";
        yield* awaitCursorRun(threadId, saved.run.id, status);
        yield* Fiber.join(stopping);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assertCursorResult(settled, saved.run.id, ordinal, status);
        assert.equal(
          settled.providerThreads[0]?.cloudTask?.status,
          outcome === "cancelled" ? "cancelled" : "succeeded",
        );
        assert.equal(
          settled.providerTurns.find((candidate) => candidate.runAttemptId === saved.attempt.id)
            ?.status,
          status,
        );
        assert.equal(h.create.mock.calls.length, creates);
        assert.equal(h.send.mock.calls.length, sends);
        assert.equal(h.runs[ordinal - 1]!.stream.mock.calls.length, streams);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "Cursor Cloud commits source before create, agent before send and acceptance before stream",
  () =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress("cursor-durable-order", {
        blockCreate: true,
        blockSend: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:cursor-durable-order");
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, { type: "start_immediately" });
        const draining = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(h.creating);
        const creating = yield* orchestrator.getThreadProjection(threadId);
        const run = creating.runs[0]!;
        assert.equal(run.status, "running");
        assert.equal(creating.providerThreads[0]?.cloudTask?.status, "submitting");
        assert.equal(creating.providerThreads[0]?.cloudTask?.taskId, run.id);
        assert.isUndefined(creating.providerThreads[0]?.cloudTask?.acceptedAppRunId);
        assert.deepEqual(creating.providerThreads[0]?.cloudTask?.source, cursorSource);
        assert.isTrue(creating.providerThreads[0]?.cloudTask?.localChangesExcluded);
        assert.isNull(creating.providerThreads[0]!.nativeThreadRef);
        assert.equal(h.send.mock.calls.length, 0);
        assert.deepEqual(h.create.mock.calls[0]![0].cloud, {
          repos: [{ url: cursorSource.repository, startingRef: cursorSource.sha }],
          workOnCurrentBranch: false,
          autoCreatePR: true,
        });
        yield* h.allowCreate;
        yield* Deferred.await(h.sending);
        const sending = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(sending.providerThreads[0]?.nativeThreadRef?.nativeId, cursorAgentId);
        assert.equal(sending.providerThreads[0]?.cloudTask?.status, "submitting");
        assert.isUndefined(sending.providerThreads[0]?.cloudTask?.acceptedAppRunId);
        assert.equal(
          sending.providerThreads[0]?.cloudTask?.url,
          `https://cursor.com/agents/${cursorAgentId}`,
        );
        assert.equal(h.runs[0]!.stream.mock.calls.length, 0);
        yield* h.allowSend;
        yield* Deferred.await(h.runs[0]!.streaming);
        const accepted = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(accepted.providerThreads[0]?.cloudTask?.taskId, "cursor-run-1");
        assert.equal(accepted.providerThreads[0]?.cloudTask?.status, "running");
        assert.equal(accepted.providerThreads[0]?.cloudTask?.acceptedAppRunId, run.id);
        assert.deepEqual(accepted.providerThreads[0]?.cloudTask?.source, cursorSource);
        yield* Fiber.join(draining);
        yield* h.runs[0]!.finish();
        yield* awaitCursorRun(threadId, run.id, "completed");
        yield* worker.drain();
        const completed = yield* orchestrator.getThreadProjection(threadId);
        assertCursorResult(completed, run.id, 1);
        assert.equal(completed.providerThreads[0]?.cloudTask?.summary, "Completed task 1.");
        assert.equal(completed.providerThreads[0]?.cloudTask?.branch, "cursor/result-1");
        assert.equal(
          completed.providerThreads[0]?.cloudTask?.prUrl,
          "https://github.com/fixture/repo/pull/1",
        );
        // An extra drain must not repeat finalization or create another provider result.
        yield* worker.drain();
        assertCursorResult(yield* orchestrator.getThreadProjection(threadId), run.id, 1);
        assert.equal(yield* Ref.get(h.adapterAssistantFinals), 0);
        assert.equal(h.create.mock.calls.length, 1);
        assert.equal(h.send.mock.calls.length, 1);
        assert.equal(h.cancelRun.mock.calls.length, 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect("Cursor Cloud never creates or sends when the durable submitting transaction fails", () =>
  Effect.gen(function* () {
    const h = yield* makeCursorIngress("cursor-intent-write-failure");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:cursor-intent-write-failure");
      yield* createCursorThread(threadId);
      yield* dispatchCursorMessage(threadId, 1, {
        type: "defer_start",
        workspaceStrategy: { type: "root" },
      });
      const prepared = yield* orchestrator.getThreadProjection(threadId);
      const run = prepared.runs[0]!;
      assert.equal(run.status, "preparing");
      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("command:cursor-release-write-failure"),
        threadId,
        runId: run.id,
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(before.runs[0]?.status, "starting");
      // Abort the real projection transaction, rather than mocking the persistence hook.
      yield* sql`
        CREATE TEMP TRIGGER reject_cursor_submitting
        BEFORE INSERT ON orchestration_v2_projection_provider_threads
        WHEN json_extract(NEW.payload_json, '$.cloudTask.status') = 'submitting'
        BEGIN SELECT RAISE(ABORT, 'fixture rejected submitting intent'); END
      `;
      const result = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
        .start({ threadId, runId: run.id })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(yield* Ref.get(h.sourceReads), 1);
      assert.equal(h.create.mock.calls.length, 0);
      assert.equal(h.resume.mock.calls.length, 0);
      assert.equal(h.send.mock.calls.length, 0);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(after.providerThreads[0]?.cloudTask);
      assert.equal(after.runs[0]?.status, before.runs[0]?.status);
      assert.equal(after.attempts[0]?.status, before.attempts[0]?.status);
      assert.equal(
        after.nodes.find((node) => node.id === run.rootNodeId)?.status,
        before.nodes.find((node) => node.id === run.rootNodeId)?.status,
      );
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped),
);

it.effect.each(["direct", "queued"] as const)(
  "Cursor Cloud %s follow-up reuses the agent and original SHA without local source resolution",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* makeCursorIngress(`cursor-follow-up-${mode}`, { blockResume: true });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`thread:cursor-follow-up-${mode}`);
        yield* createCursorThread(threadId);
        yield* dispatchCursorMessage(threadId, 1, { type: "start_immediately" });
        yield* worker.drain();
        yield* Deferred.await(h.runs[0]!.streaming);
        const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        if (mode === "queued") {
          yield* dispatchCursorMessage(threadId, 2, { type: "queue_after_active" });
          yield* worker.drain();
          const queued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(queued.runs.find((run) => run.ordinal === 2)?.status, "queued");
          assert.equal(h.resume.mock.calls.length, 0);
          assert.equal(h.send.mock.calls.length, 1);
        }
        yield* h.runs[0]!.finish();
        yield* awaitCursorRun(threadId, first.id, "completed");
        const firstCompleted = yield* orchestrator.getThreadProjection(threadId);
        const firstResult = assertCursorResult(firstCompleted, first.id, 1);
        assert.equal(yield* Ref.get(h.adapterAssistantFinals), 0);
        if (mode === "direct")
          yield* dispatchCursorMessage(threadId, 2, { type: "start_immediately" });
        const resuming = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(h.resuming);
        const submitting = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(assertCursorResult(submitting, first.id, 1), firstResult);
        assert.equal(submitting.providerThreads[0]?.cloudTask?.status, "submitting");
        assert.equal(submitting.providerThreads[0]?.cloudTask?.taskId, "cursor-run-1");
        assert.equal(submitting.providerThreads[0]?.cloudTask?.acceptedAppRunId, first.id);
        assert.equal(submitting.providerThreads[0]?.cloudTask?.summary, "Completed task 1.");
        assert.equal(
          submitting.providerThreads[0]?.cloudTask?.prUrl,
          "https://github.com/fixture/repo/pull/1",
        );
        assert.equal(submitting.providerThreads[0]?.cloudTask?.branch, "cursor/result-1");
        assert.deepEqual(submitting.providerThreads[0]?.cloudTask?.source, cursorSource);
        assert.equal(submitting.providerThreads[0]?.nativeThreadRef?.nativeId, cursorAgentId);
        assert.equal(
          submitting.providerThreads[0]?.cloudTask?.url,
          `https://cursor.com/agents/${cursorAgentId}`,
        );
        assert.equal(h.send.mock.calls.length, 1);
        yield* h.allowResume;
        yield* Fiber.join(resuming);
        yield* Deferred.await(h.runs[1]!.streaming);
        const followUp = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.ordinal === 2,
        )!;
        yield* awaitCursorTurn(threadId, followUp.activeAttemptId!);
        const second = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(assertCursorResult(second, first.id, 1), firstResult);
        assert.equal(h.create.mock.calls.length, 1);
        assert.equal(h.resume.mock.calls.length, 1);
        assert.equal(h.resume.mock.calls[0]![0], cursorAgentId);
        assert.equal(h.send.mock.calls.length, 2);
        assert.equal(yield* Ref.get(h.sourceReads), 1);
        assert.deepEqual(second.providerThreads[0]?.cloudTask?.source, cursorSource);
        assert.equal(second.providerThreads[0]?.nativeThreadRef?.nativeId, cursorAgentId);
        assert.equal(second.providerThreads[0]?.cloudTask?.taskId, "cursor-run-2");
        assert.equal(second.providerThreads[0]?.cloudTask?.acceptedAppRunId, followUp.id);
        assert.isUndefined(second.providerThreads[0]?.cloudTask?.summary);
        assert.equal(
          second.providerThreads[0]?.cloudTask?.prUrl,
          "https://github.com/fixture/repo/pull/1",
        );
        assert.equal(
          second.providerTurns.find((turn) => turn.runAttemptId === first.activeAttemptId)?.ordinal,
          1,
        );
        assert.equal(
          second.providerTurns.find((turn) => turn.runAttemptId === followUp.activeAttemptId)
            ?.ordinal,
          2,
        );
        yield* h.runs[1]!.finish();
        yield* awaitCursorRun(threadId, followUp.id, "completed");
        yield* worker.drain();
        const completed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(assertCursorResult(completed, first.id, 1), firstResult);
        assertCursorResult(completed, followUp.id, 2);
        assert.equal(
          completed.messages.filter((message) => message.role === "assistant").length,
          2,
        );
        assert.equal(
          completed.turnItems.filter((item) => item.type === "assistant_message").length,
          2,
        );
        assert.equal(
          completed.visibleTurnItems.filter((row) => row.item.type === "assistant_message").length,
          2,
        );
        assert.equal(yield* Ref.get(h.adapterAssistantFinals), 0);
        yield* worker.drain();
        const redrained = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(redrained.messages, completed.messages);
        assert.deepEqual(redrained.turnItems, completed.turnItems);
        assert.deepEqual(redrained.visibleTurnItems, completed.visibleTurnItems);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "serializes cloud direct, queued and MCP admission before durable second messages exist",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeCloudAdapter(false);
      // Reuse an enabled test slot; the registered adapter is still the test fakeCloud driver.
      // No provider session opens because the first run is explicitly deferred.
      const instanceId = ProviderInstanceId.make("codex");
      const adapter = { ...fake.adapter, instanceId };
      const layer = layerWithRegistry(
        { name: "cloud-ingress" },
        Registry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:cloud-ingress");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:cloud-create"),
          threadId,
          projectId: ProjectId.make("project:cloud-ingress"),
          title: "Cloud task",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "dev",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:cloud-first"),
          threadId,
          messageId: MessageId.make("message:cloud-first"),
          text: "First cloud task",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root", branch: "dev" } },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.runs.length, 1);
        assert.equal(before.checkpointScopes.length, 0);
        assert.isTrue(before.nodes.every((node) => node.checkpointScopeId === null));
        const calls: ReadonlyArray<
          Pick<
            Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
            "dispatchMode" | "createdBy" | "creationSource"
          >
        > = [
          { dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "web" },
          {
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          },
          {
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          },
          {
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          },
        ];
        for (const [index, call] of calls.entries()) {
          const error = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:cloud-second:${index}`),
              threadId,
              messageId: MessageId.make(`message:cloud-second:${index}`),
              text: "Must not submit",
              attachments: [],
              ...call,
            })
            .pipe(Effect.flip);
          assert.isTrue(Cause.pretty(Cause.fail(error)).includes("Fake Cloud has no follow-up"));
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.length, 1);
        assert.equal(after.messages.length, before.messages.length);
        assert.equal(yield* Ref.get(fake.submissions), 0);
        // Round-trip the provider-thread payload through the real SQLite projection.
        const thread = after.providerThreads[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:cloud-task-roundtrip"),
              type: "provider-thread.updated",
              threadId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                ...thread,
                cloudTask: {
                  taskId: "remote-1",
                  status: "running",
                  tracking: "polled",
                  source: {
                    repository: "https://github.com/acme/repo",
                    branch: "dev",
                    sha: "a".repeat(40),
                  },
                  localChangesExcluded: true,
                  updatedAt: DateTime.formatIso(now),
                },
              },
            },
          ],
        });
        const reconnect = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(reconnect.providerThreads[0]?.cloudTask?.taskId, "remote-1");
        assert.equal(reconnect.providerThreads[0]?.cloudTask?.source.branch, "dev");
        assert.isTrue(reconnect.providerThreads[0]?.cloudTask?.localChangesExcluded);
        // Older queued state must not bypass the new one-shot guard on promote or resume.
        const original = reconnect.runs[0]!;
        const originalNode = reconnect.nodes.find((node) => node.id === original.rootNodeId)!;
        const originalAttempt = reconnect.attempts.find(
          (attempt) => attempt.id === original.activeAttemptId,
        )!;
        const originalMessage = reconnect.messages.find(
          (message) => message.id === original.userMessageId,
        )!;
        const queuedId = RunId.make("run:legacy-cloud-queue");
        const queuedNodeId = NodeId.make("node:legacy-cloud-queue");
        const queuedAttemptId = RunAttemptId.make("attempt:legacy-cloud-queue");
        const queuedMessageId = MessageId.make("message:legacy-cloud-queue");
        const queued = {
          ...original,
          id: queuedId,
          ordinal: original.ordinal + 1,
          userMessageId: queuedMessageId,
          rootNodeId: queuedNodeId,
          activeAttemptId: queuedAttemptId,
          status: "queued" as const,
          queueHeld: true,
          queuePosition: 1,
          startedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:legacy-cloud-run"),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: queued,
            },
            {
              id: EventId.make("event:legacy-cloud-node"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalNode,
                id: queuedNodeId,
                rootNodeId: queuedNodeId,
                runId: queuedId,
                status: "pending",
                startedAt: null,
              },
            },
            {
              id: EventId.make("event:legacy-cloud-attempt"),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                ...originalAttempt,
                id: queuedAttemptId,
                runId: queuedId,
                rootNodeId: queuedNodeId,
                status: "pending",
                startedAt: null,
              },
            },
            {
              id: EventId.make("event:legacy-cloud-message"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalMessage,
                id: queuedMessageId,
                runId: queuedId,
                nodeId: queuedNodeId,
                text: "Cannot follow up",
              },
            },
          ],
        });
        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("command:cloud-promote"),
            threadId,
            queuedRunId: queuedId,
            targetRunId: original.id,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Cause.pretty(Cause.fail(promoteError)).includes("Fake Cloud has no follow-up"),
        );
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:cloud-first-completed"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...original, status: "completed", startedAt: now, completedAt: now },
            },
            {
              id: EventId.make("event:cloud-first-node-completed"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...originalNode, status: "completed", completedAt: now },
            },
            {
              id: EventId.make("event:cloud-first-attempt-completed"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...originalAttempt, status: "completed", completedAt: now },
            },
          ],
        });
        const resumeError = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("command:cloud-resume-queue"),
            threadId,
          })
          .pipe(Effect.flip);
        assert.isTrue(
          Cause.pretty(Cause.fail(resumeError)).includes("Fake Cloud has no follow-up"),
        );
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.find((run) => run.id === queuedId)?.status, "queued");
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(resumed.checkpointScopes.length, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { outcome: "succeeded", resultBeforeStop: false },
  { outcome: "cancelled", resultBeforeStop: false },
  { outcome: "unknown", resultBeforeStop: false },
  { outcome: "rejected", resultBeforeStop: false },
  { outcome: "succeeded", resultBeforeStop: true },
  { outcome: "cancelled", resultBeforeStop: true },
] as const)(
  "cloud $outcome settlement retains parent delivery resultBeforeStop=$resultBeforeStop",
  ({ outcome, resultBeforeStop }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const interruptEntered = yield* Deferred.make<void>();
      const acknowledge = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const observerReady = yield* Deferred.make<void>();
      const observerRelease = yield* Deferred.make<void>();
      const observerClosed = yield* Deferred.make<void>();
      const resultPersisted = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const lateCallbacks = yield* Ref.make(0);
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            const session = yield* fake.adapter.openSession(input);
            const scope = yield* Scope.Scope;
            return {
              ...session,
              startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                session.startTurn(turn).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      // The attached observer belongs to the provider runtime, not the run.
                      yield* Deferred.await(observerRelease).pipe(
                        Effect.andThen(Ref.update(lateCallbacks, (count) => count + 1)),
                        Effect.andThen(
                          turn.commitCloudTaskMetadata!("native-session-1", {
                            title: "Disposed observer",
                          }),
                        ),
                        Effect.ensuring(Deferred.succeed(observerClosed, undefined)),
                        Effect.forkIn(scope),
                      );
                      yield* Deferred.succeed(observerReady, undefined);
                    }),
                  ),
                ),
              interruptTurn: (request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
                Deferred.succeed(interruptEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(acknowledge)),
                  Effect.andThen(session.interruptTurn(request)),
                ),
            };
          }),
      };
      const registry = Registry.layerFromAdapters([adapter]);
      const projectId = ProjectId.make("project:cloud-cancel");
      const projects = Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              workspaceRoot: "/repo",
              defaultModelSelection: { instanceId, model: "fake" },
            } as Project),
          ),
      });
      const runtime = layerWithRegistry({ name: `cloud-cancel-${outcome}` }, registry, {
        runEffectWorker: false,
        projects,
        cloudSources: Layer.succeed(CloudSource.CloudTaskSourceService, {
          resolve: (input) =>
            Effect.succeed({
              source: { repository: "https://github.com/acme/repo", branch: "dev" },
              launchSource: { cwd: input.cwd, restriction: "published-ref" },
              localChangesExcluded: true,
            }),
        }),
        continuationRequests: Layer.succeed(
          ProviderContinuationRequests.ProviderContinuationRequests,
          {
            offer: (request) =>
              Effect.sync(() => {
                offers.push(request);
              }).pipe(Effect.andThen(Deferred.succeed(delivered, undefined)), Effect.asVoid),
            take: Effect.never,
          },
        ),
      });
      const mcp = cloudDelegationMcpLayer(runtime, registry, projects);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { parentId, delegation } = yield* seedCloudDelegation(
          "cloud-cancel",
          projectId,
          instanceId,
          "Cloud work",
        );
        const taskEvent = delegation.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        assert.equal(taskEvent?.event.type, "subagent.updated");
        if (taskEvent?.event.type !== "subagent.updated") return;
        const taskId = taskEvent.event.payload.id;
        const childId = taskEvent.event.payload.childThreadId!;
        const accepted = yield* orchestrator
          .streamStoredEventsFrom({ threadId: childId, eventType: "provider-turn.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* worker.drain();
        yield* Fiber.join(accepted);
        const childBeforeStop = yield* orchestrator.getThreadProjection(childId);
        const childRun = childBeforeStop.runs[0]!;
        assert.equal(childBeforeStop.providerThreads[0]?.cloudTask?.acceptedAppRunId, childRun.id);
        const finishing = resultBeforeStop
          ? yield* fake
              .finish(
                false,
                outcome,
                Deferred.succeed(resultPersisted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTerminal)),
                ),
              )
              .pipe(Effect.forkChild)
          : null;
        if (finishing !== null) yield* Deferred.await(resultPersisted);
        const savedTask = (yield* orchestrator.getThreadProjection(childId)).providerThreads[0]
          ?.cloudTask;
        if (resultBeforeStop) assert.equal(savedTask?.status, outcome);
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("env:cloud-cancel"),
          requestNamespace: `cloud-cancel-${outcome}`,
          thread: {
            threadId: parentId,
            providerSessionId: "ps:parent",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const result = yield* (yield* McpServer.McpServer)
          .callTool({ name: "task_cancel", arguments: { taskId, clientRequestId: "stop-child" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, cloudMcpClient),
          );
        assert.isFalse(result.isError === true);
        assert.equal(decodeTaskCancelResult(result.structuredContent).status, "cancel_requested");
        const draining = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(interruptEntered);
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery
            ?.state,
          "pending",
        );
        yield* Deferred.succeed(acknowledge, undefined);
        yield* Fiber.join(draining);
        const acknowledged = yield* orchestrator.getThreadProjection(childId);
        assert.equal(acknowledged.runs[0]?.status, "running");
        assert.equal(acknowledged.attempts[0]?.status, "running");
        assert.deepEqual(acknowledged.providerThreads[0]?.cloudTask, savedTask);
        assert.equal(yield* Ref.get(fake.cancellations), 1);
        const captured = (yield* Ref.get(fake.current))!;
        const terminal: ProviderAdapter.ProviderAdapterV2Event = {
          type: "turn.terminal",
          driver: fake.adapter.driver,
          providerThreadId: captured.providerThread.id,
          providerTurnId: ProviderTurnId.make(`provider-turn:fake-cloud:${captured.attemptId}`),
          runOrdinal: captured.runOrdinal,
          ...(outcome === "unknown" || outcome === "rejected"
            ? {
                status: "failed" as const,
                failureItemOrdinal: 101,
                failure: {
                  class:
                    outcome === "rejected" ? ("provider_error" as const) : ("unknown" as const),
                  message: "Observation lost",
                  code: outcome === "rejected" ? CLOUD_DELIVERY_REJECTED_CODE : null,
                  retryable: null,
                },
              }
            : {
                status: outcome === "cancelled" ? ("cancelled" as const) : ("completed" as const),
                failure: null,
              }),
          threadDisposition: "reusable",
        };
        if (outcome === "unknown" || outcome === "rejected") {
          yield* captured.commitCloudTask!({ ...savedTask!, summary: "Last observed summary" });
          yield* fake.publish(terminal);
        } else if (finishing !== null) {
          yield* Deferred.succeed(releaseTerminal, undefined);
          yield* Fiber.join(finishing);
        } else {
          yield* fake.finish(false, outcome);
        }
        yield* Deferred.await(delivered);
        yield* worker.drain();
        const finished = yield* orchestrator.getThreadProjection(childId);
        assert.equal(
          finished.runs[0]?.status,
          outcome === "unknown" || outcome === "rejected"
            ? "failed"
            : outcome === "cancelled"
              ? "cancelled"
              : "completed",
        );
        assert.equal(
          finished.providerThreads[0]?.cloudTask?.status,
          outcome === "rejected" ? "running" : outcome,
        );
        assert.equal(
          finished.messages.filter(
            (message) => message.id === `message:cloud-result:${childRun.id}`,
          ).length,
          1,
        );
        const resultBefore = finished.messages.find(
          (message) => message.id === `message:cloud-result:${childRun.id}`,
        )!;
        assert.isFalse(resultBefore.streaming);
        assert.isTrue(
          resultBefore.text.includes(
            outcome === "unknown" || outcome === "rejected"
              ? "Last observed summary"
              : "Completed fake task",
          ),
        );
        const resultItemBefore = assertCloudResultItem(finished, childRun.id);
        if (outcome === "unknown" || outcome === "rejected") {
          assert.notInclude(resultItemBefore.text, "Pull request:");
          assert.notInclude(resultItemBefore.text, "Branch:");
        } else {
          assert.include(
            resultItemBefore.text,
            "Pull request: https://github.com/acme/repo/pull/1",
          );
          assert.include(resultItemBefore.text, "Branch: `agent/fix`");
        }
        const metadata = {
          url: "https://example.com/tasks/refreshed",
          title: "Late title",
          progress: "Blocked after end_turn",
        };
        // This callback must wait for real ingestion cleanup, including the final full-thread write.
        const untrustedMetadata = {
          ...metadata,
          acceptedAppRunId: RunId.make("run:foreign-metadata"),
        };
        yield* captured.commitCloudTaskMetadata!("native-session-1", untrustedMetadata);
        const refreshed = yield* orchestrator.getThreadProjection(childId);
        const beforeProvider = finished.providerThreads[0]!;
        const afterProvider = refreshed.providerThreads[0]!;
        const { updatedAt: _beforeAt, ...beforeTask } = beforeProvider.cloudTask!;
        const { updatedAt: _afterAt, ...afterTask } = afterProvider.cloudTask!;
        assert.deepEqual(afterTask, { ...beforeTask, ...metadata });
        assert.equal(afterTask.acceptedAppRunId, childRun.id);
        assert.equal(afterProvider.status, beforeProvider.status);
        assert.deepEqual(refreshed.runs, finished.runs);
        assert.deepEqual(refreshed.attempts, finished.attempts);
        assert.deepEqual(refreshed.nodes, finished.nodes);
        assert.deepEqual(refreshed.messages, finished.messages);
        assert.deepEqual(refreshed.turnItems, finished.turnItems);
        assert.equal(refreshed.thread.settledAt, finished.thread.settledAt);
        const sequence = yield* sink.latestSequence();
        yield* captured.commitCloudTaskMetadata!("native-session-1", metadata);
        yield* captured.commitCloudTaskMetadata!("foreign-session", { title: "Foreign title" });
        assert.equal(yield* sink.latestSequence(), sequence);

        // Observe the manager pump's duplicate terminal, after the original run subscriber closed.
        const session = Option.getOrThrow(
          yield* (yield* ProviderSessions.ProviderSessionManagerV2).get(
            afterProvider.providerSessionId!,
          ),
        );
        const duplicateSubscription = yield* session.subscribeEvents!;
        const duplicateSeen = yield* duplicateSubscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* fake.publish(terminal);
        yield* Fiber.join(duplicateSeen);
        yield* duplicateSubscription.close;
        yield* worker.drain();
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(childId)).messages,
          finished.messages,
        );
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(childId)).turnItems,
          finished.turnItems,
        );
        assert.equal(offers.length, 1);
        const delivery = offers[0]!.delegatedCompletion!;
        if (outcome !== "unknown") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:deliver-cloud-result"),
            threadId: parentId,
            messageId: delivery.messageId,
            text: "The delegated cloud task has returned its result.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: {
              parentRunId: delivery.parentRunId,
              generation: delivery.generation,
              taskIds: [taskId],
            },
          });
        }
        if (outcome !== "unknown") yield* orchestrator.recoverDelegatedTasks;
        assert.equal(offers.length, 1);
        const parent = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(parent.subagents[0]?.completionDelivery?.state, "claimed");
        assert.equal(
          parent.runs.filter((run) => run.delegatedCompletion?.delivery != null).length,
          1,
        );
        assert.equal(
          parent.messages.filter((message) => message.delegatedCompletion !== undefined).length,
          outcome === "unknown" ? 0 : 1,
        );
        assert.equal(yield* Ref.get(fake.submissions), 1);
        const mcpServer = yield* McpServer.McpServer;
        const invoke = (name: string, arguments_: Record<string, unknown>) =>
          mcpServer
            .callTool({ name, arguments: arguments_ })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, cloudMcpClient),
            );
        const statusResult = yield* invoke("goat_thread_status", { threadId: childId });
        assert.isFalse(statusResult.isError === true, JSON.stringify(statusResult.content));
        const statusView = yield* decodeThreadStatus(statusResult.structuredContent);
        const readResult = yield* invoke("goat_thread_read", { threadId: childId });
        assert.isFalse(readResult.isError === true, JSON.stringify(readResult.content));
        const readView = yield* decodeThreadRead(readResult.structuredContent);
        const taskResult = yield* invoke("task_status", { taskId });
        assert.isFalse(taskResult.isError === true, JSON.stringify(taskResult.content));
        const taskView = yield* decodeTaskStatus(taskResult.structuredContent);
        for (const view of [statusView, readView, taskView]) {
          assert.equal(view.cloudTask?.url, metadata.url);
          assert.equal(view.cloudTask?.progress, metadata.progress);
          assert.equal(view.cloudTask?.status, outcome === "rejected" ? "running" : outcome);
          assert.isFalse(Object.hasOwn(view.cloudTask!, "acceptedAppRunId"));
          assert.isFalse(Object.values(view.cloudTask!).includes(undefined));
        }
        assert.isTrue(statusView.terminal);
        assert.equal(offers.length, 1);
        if (outcome !== "unknown") {
          // Hold the old observer's callback while a real follow-up claims the same native session.
          const staleReady = yield* Deferred.make<void>();
          const staleRelease = yield* Deferred.make<void>();
          const stale = yield* Deferred.succeed(staleReady, undefined).pipe(
            Effect.andThen(Deferred.await(staleRelease)),
            Effect.andThen(
              captured.commitCloudTaskMetadata!("native-session-1", {
                title: "Old observer",
                progress: "Stale activity",
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(staleReady);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:metadata-followup"),
            threadId: childId,
            messageId: MessageId.make("message:metadata-followup"),
            text: "Follow up in the same session",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const successorInput = (yield* Ref.get(fake.current))!;
          const successorAccepted = yield* sink
            .stream({ threadId: childId, eventType: "provider-turn.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === successorInput.attemptId,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
          yield* Fiber.join(successorAccepted);
          assert.notEqual(successorInput.runId, captured.runId);
          // startTurn sees the submitting intent before the provider commits the new acceptance.
          assert.equal(successorInput.providerThread.cloudTask?.status, "submitting");
          assert.equal(successorInput.providerThread.cloudTask?.acceptedAppRunId, captured.runId);
          assert.deepEqual(
            successorInput.providerThread.nativeThreadRef,
            afterProvider.nativeThreadRef,
          );
          const {
            status: _status,
            updatedAt: _updatedAt,
            ...submittingTask
          } = successorInput.providerThread.cloudTask!;
          const {
            status: _previousStatus,
            updatedAt: _previousUpdatedAt,
            ...previousTask
          } = afterProvider.cloudTask!;
          assert.deepEqual(submittingTask, previousTask);
          const successor = yield* orchestrator.getThreadProjection(childId);
          assert.equal(successor.providerThreads[0]!.nativeThreadRef?.nativeId, "native-session-1");
          assert.equal(successor.providerThreads[0]!.cloudTask?.status, "running");
          assert.equal(
            successor.providerThreads[0]!.cloudTask?.acceptedAppRunId,
            successorInput.runId,
          );
          const successorSequence = yield* sink.latestSequence();
          yield* Deferred.succeed(staleRelease, undefined);
          yield* Fiber.join(stale);
          assert.equal(yield* sink.latestSequence(), successorSequence);
          assert.deepEqual(yield* orchestrator.getThreadProjection(childId), successor);
          // Settle the successor before proving runtime disposal never reopens either run.
          yield* fake.finish();
          yield* successorInput.commitCloudTaskMetadata!("native-session-1", {});
          yield* worker.drain();
          const followedUp = yield* orchestrator.getThreadProjection(childId);
          assert.deepEqual(assertCloudResultItem(followedUp, childRun.id), resultItemBefore);
          const successorResult = assertCloudResultItem(followedUp, successorInput.runId);
          assert.include(successorResult.text, "Completed fake task");
          assert.include(successorResult.text, "https://github.com/acme/repo/pull/1");
          assert.equal(
            followedUp.turnItems.filter((item) => item.type === "assistant_message").length,
            2,
          );
        }
        const beforeDisposal = yield* orchestrator.getThreadProjection(childId);
        // Runtime disposal interrupts the attached observer without a remote cancel or new terminal.
        yield* Deferred.await(observerReady);
        yield* (yield* ProviderSessions.ProviderSessionManagerV2).close(
          afterProvider.providerSessionId!,
        );
        yield* Deferred.await(observerClosed);
        yield* Deferred.succeed(observerRelease, undefined);
        assert.equal(yield* Ref.get(lateCallbacks), 0);
        assert.equal(yield* Ref.get(fake.cancellations), 1);
        assert.equal(yield* Ref.get(fake.detaches), 1);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(childId)).runs,
          beforeDisposal.runs,
        );
      }).pipe(Effect.provide(mcp));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { ownershipLost: false, stage: "open", taskStatus: "running" },
  { ownershipLost: false, stage: "open", taskStatus: "unknown" },
  { ownershipLost: true, stage: "open", taskStatus: "running" },
  { ownershipLost: false, stage: "resume", taskStatus: "running" },
  { ownershipLost: false, stage: "resume", taskStatus: "unknown" },
  { ownershipLost: true, stage: "resume", taskStatus: "running" },
] as const)(
  "final attach $stage failure settles $taskStatus task only for its original attempt ownershipLost=$ownershipLost",
  ({ ownershipLost, stage, taskStatus }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      let opening = yield* Deferred.make<void>();
      let failOpen = yield* Deferred.make<void>();
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            const failure = () =>
              Deferred.succeed(opening, undefined).pipe(
                Effect.andThen(Deferred.await(failOpen)),
                Effect.andThen(
                  Effect.fail(
                    new ProviderAdapterOpenSessionError({
                      driver: fake.adapter.driver,
                      providerSessionId: input.providerSessionId,
                      cause: "Tracking transport unavailable",
                    }),
                  ),
                ),
              );
            if (stage === "open") return yield* failure();
            const session = yield* fake.adapter.openSession(input);
            return { ...session, resumeTurn: failure };
          }),
      };
      const runtime = Layer.merge(
        layerWithRegistry(
          { name: `cloud-attach-${stage}-failure-${ownershipLost}-${taskStatus}` },
          Registry.layerFromAdapters([adapter]),
          { runEffectWorker: false },
        ),
        EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const threadId = ThreadId.make("thread:cloud-open-failure");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:open-failure-thread"),
          threadId,
          projectId: ProjectId.make("project:open-failure"),
          title: "Recover cloud task",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "deleted-local-branch",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:open-failure-run"),
          threadId,
          messageId: MessageId.make("message:open-failure"),
          text: "Original prompt",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs[0]!;
        const attempt = initial.attempts[0]!;
        const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
        const providerThread = initial.providerThreads[0]!;
        const now = yield* DateTime.now;
        const task = {
          taskId: "accepted-before-restart",
          status: taskStatus,
          tracking: "live" as const,
          url: "https://example.com/tasks/saved",
          source: {
            repository: "https://github.com/acme/repo",
            branch: "dev",
            sha: "a".repeat(40),
          },
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        const savedThread = {
          ...providerThread,
          cloudTask: task,
          nativeThreadRef: {
            driver: fake.adapter.driver,
            nativeId: "accepted-native-session",
            strength: "strong" as const,
          },
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:open-failure-run"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-attempt"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...attempt, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-node"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...root, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:open-failure-task"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: savedThread,
            },
          ],
        });
        const savedTurnId =
          stage === "resume" ? ProviderTurnId.make("provider-turn:saved-cloud") : null;
        if (savedTurnId !== null)
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:open-failure-provider-turn"),
                type: "provider-turn.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: savedTurnId,
                  providerThreadId: providerThread.id,
                  nodeId: root.id,
                  runAttemptId: attempt.id,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
        const starter = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        // A retryable attach failure must leave the task live and emit no result.
        const retrying = yield* starter
          .start({ threadId, runId: run.id, reattach: true, willRetry: true })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(opening);
        yield* Deferred.succeed(failOpen, undefined);
        assert.equal((yield* Fiber.join(retrying))._tag, "Failure");
        const afterRetry = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterRetry.runs[0]?.status, "running");
        assert.equal(afterRetry.providerThreads[0]?.cloudTask?.status, taskStatus);
        assert.isFalse(
          afterRetry.turnItems.some((item) => item.id === `turn-item:cloud-result:${run.id}`),
        );
        assert.isFalse(
          afterRetry.messages.some((message) => message.id === `message:cloud-result:${run.id}`),
        );
        // Gate the final attempt independently so the ownership race stays deterministic.
        opening = yield* Deferred.make<void>();
        failOpen = yield* Deferred.make<void>();
        const beforeFailureSequence = yield* sink.latestSequence({ threadId });
        const starting = yield* starter
          .start({
            threadId,
            runId: run.id,
            reattach: true,
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(opening);
        const newerAttemptId = RunAttemptId.make("attempt:newer-cloud-owner");
        if (ownershipLost)
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:newer-cloud-attempt"),
                type: "run-attempt.created",
                threadId,
                occurredAt: now,
                payload: { ...attempt, id: newerAttemptId, attemptOrdinal: 2, status: "running" },
              },
              {
                id: EventId.make("event:newer-cloud-owner"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...run,
                  status: "running",
                  activeAttemptId: newerAttemptId,
                  startedAt: now,
                },
              },
            ],
          });
        yield* Deferred.succeed(failOpen, undefined);
        assert.equal((yield* Fiber.join(starting))._tag, "Failure");
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, ownershipLost ? "running" : "failed");
        assert.equal(
          after.providerThreads[0]?.cloudTask?.status,
          ownershipLost ? taskStatus : "unknown",
        );
        assert.deepEqual(after.providerThreads[0]?.nativeThreadRef, savedThread.nativeThreadRef);
        assert.deepEqual(after.providerThreads[0]?.cloudTask?.source, task.source);
        assert.equal(after.providerThreads[0]?.cloudTask?.url, task.url);
        if (ownershipLost) {
          assert.equal(after.runs[0]?.activeAttemptId, newerAttemptId);
          assert.isFalse(
            after.turnItems.some((item) => item.id === `turn-item:cloud-result:${run.id}`),
          );
          assert.isFalse(
            after.visibleTurnItems.some(
              (row) => row.sourceItemId === `turn-item:cloud-result:${run.id}`,
            ),
          );
          assert.equal(
            after.messages.filter((message) => message.id === `message:cloud-result:${run.id}`)
              .length,
            0,
          );
        } else {
          assert.equal(after.attempts[0]?.status, "failed");
          assert.equal(after.nodes.find((node) => node.id === root.id)?.status, "failed");
          assert.isTrue(
            after.providerThreads[0]?.cloudTask?.error?.includes("remote work may continue"),
          );
          const result = assertCloudResultItem(after, run.id);
          assert.equal(
            result.text,
            "Cloud tracking could not be reattached. Open the task link; remote work may continue.\n\n- Cloud task: https://example.com/tasks/saved",
          );
          assert.equal(result.providerThreadId, providerThread.id);
          assert.equal(result.providerTurnId, savedTurnId);
          const resultEvents = yield* eventStore
            .read({ threadId, afterSequence: beforeFailureSequence })
            .pipe(Stream.runCollect);
          const persistedResults = resultEvents.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" && stored.event.payload.id === result.id,
          );
          assert.equal(persistedResults.length, 1);
          // Replay the pair with fresh event ids: EventSink must keep its text, time and position.
          const replay = yield* sink.write({
            events: yield* Effect.forEach(
              resultEvents.filter(
                (stored) =>
                  stored.event.type === "message.updated" ||
                  stored.event.type === "turn-item.updated",
              ),
              (stored, index) =>
                Effect.succeed({
                  ...stored.event,
                  id: EventId.make(`event:attach-result-replay:${index}`),
                }),
            ),
          });
          assert.equal(replay.length, 0);
          yield* starter.start({ threadId, runId: run.id, reattach: true }).pipe(Effect.result);
          const replayed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(assertCloudResultItem(replayed, run.id), result);
          const replayedResults = yield* eventStore
            .read({
              threadId,
              afterSequence: beforeFailureSequence,
              eventType: "turn-item.updated",
            })
            .pipe(Stream.runCollect);
          assert.equal(
            replayedResults.filter(
              (stored) =>
                stored.event.type === "turn-item.updated" && stored.event.payload.id === result.id,
            ).length,
            1,
          );
        }
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(yield* Ref.get(fake.creations), 0);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped),
);

it.effect.each([
  {
    taskStatus: "unknown",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "open",
    savedStart: true,
  },
  {
    taskStatus: "unknown",
    previousOrdinal: 0,
    recordedOrdinal: 1,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "succeeded",
    previousOrdinal: 4,
    recordedOrdinal: 5,
    expectedOrdinal: 5,
    failure: "resume",
    savedStart: true,
  },
  {
    taskStatus: "succeeded",
    previousOrdinal: 4,
    recordedOrdinal: null,
    expectedOrdinal: 5,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "failed",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: false,
  },
  {
    taskStatus: "cancelled",
    previousOrdinal: 0,
    recordedOrdinal: null,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "running",
    previousOrdinal: 4,
    recordedOrdinal: 2,
    expectedOrdinal: 2,
    failure: "none",
    savedStart: true,
  },
  {
    taskStatus: "running",
    previousOrdinal: 0,
    recordedOrdinal: 1,
    expectedOrdinal: 1,
    failure: "none",
    savedStart: true,
  },
] as const)(
  "recovers accepted $taskStatus task ordinal=$expectedOrdinal after $failure failure savedStart=$savedStart",
  (scenario) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const delivered = yield* Deferred.make<void>();
      const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const originalStart = DateTime.makeUnsafe(1_000);
      const adapterStart = DateTime.makeUnsafe(10_000);
      let opens = 0;
      let resumes = 0;
      const adapter = {
        ...fake.adapter,
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.gen(function* () {
            opens += 1;
            if (scenario.failure === "open" && opens === 1)
              return yield* new ProviderAdapterOpenSessionError({
                driver: fake.adapter.driver,
                providerSessionId: input.providerSessionId,
                cause: "Transient open failure",
              });
            const session = yield* fake.adapter.openSession(input);
            return {
              ...session,
              resumeTurn: (
                turn: Parameters<
                  NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeTurn"]>
                >[0],
              ) =>
                Effect.gen(function* () {
                  resumes += 1;
                  if (scenario.failure === "resume" && resumes === 1)
                    return yield* new ProviderAdapterTurnStartError({
                      driver: fake.adapter.driver,
                      threadId: turn.threadId,
                      providerThreadId: turn.providerThread.id,
                      runId: turn.runId,
                      cause: "Transient observer failure",
                    });
                  yield* session.resumeTurn!(turn);
                  yield* fake.publish({
                    type: "provider_turn.updated",
                    driver: fake.adapter.driver,
                    threadId: turn.threadId,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:fake-cloud:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver: fake.adapter.driver,
                        nativeId: turn.cloudTask.taskId,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: scenario.taskStatus === "unknown" ? null : adapterStart,
                      completedAt: null,
                    },
                  });
                }),
            };
          }),
      };
      const runtime = layerWithRegistry(
        { name: `cloud-recovery-regression-${scenario.taskStatus}` },
        Registry.layerFromAdapters([adapter]),
        {
          runEffectWorker: false,
          continuationRequests: Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            {
              offer: (request) =>
                Effect.sync(() => offers.push(request)).pipe(
                  Effect.andThen(Deferred.succeed(delivered, undefined)),
                  Effect.asVoid,
                ),
              take: Effect.never,
            },
          ),
        },
      );
      const mcp = cloudDelegationMcpLayer(
        Layer.merge(
          runtime,
          CommandReceipts.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        ),
        Registry.layerFromAdapters([adapter]),
        Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedNone }),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        const { parentId, now } = yield* seedCloudDelegation(
          "recovery",
          ProjectId.make("project:recovery"),
          instanceId,
          "Accepted cloud work",
        );
        const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
        const childId = task.childThreadId!;
        const initial = yield* orchestrator.getThreadProjection(childId);
        const run = initial.runs[0]!;
        const attempt = initial.attempts[0]!;
        const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
        const thread = initial.providerThreads[0]!;
        const cloudTask = {
          taskId: "accepted-before-restart",
          status: scenario.taskStatus,
          tracking: "live" as const,
          source: {
            repository: "https://github.com/acme/repo",
            branch: "dev",
            sha: "a".repeat(40),
          },
          url: "https://example.com/tasks/saved",
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        const startedAt = scenario.savedStart ? originalStart : null;
        for (const event of [
          { type: "run.updated", payload: { ...run, status: "running", startedAt } },
          { type: "run-attempt.updated", payload: { ...attempt, status: "running", startedAt } },
          { type: "node.updated", payload: { ...root, status: "running", startedAt } },
          {
            type: "provider-thread.updated",
            payload: {
              ...thread,
              cloudTask,
              nativeThreadRef: {
                driver: fake.adapter.driver,
                nativeId: "accepted-native-session",
                strength: "strong",
              },
            },
          },
        ] as const)
          yield* sink.write({
            events: [
              {
                ...event,
                id: EventId.make(`event:recovery:${event.type}`),
                threadId: childId,
                occurredAt: now,
              },
            ],
          });
        const turnId = ProviderTurnId.make(`provider-turn:fake-cloud:${attempt.id}`);
        for (const savedTurn of [
          ...(scenario.previousOrdinal === 0
            ? []
            : [
                {
                  id: ProviderTurnId.make("turn:earlier"),
                  runAttemptId: RunAttemptId.make("attempt:earlier"),
                  ordinal: scenario.previousOrdinal,
                },
              ]),
          ...(scenario.recordedOrdinal === null
            ? []
            : [{ id: turnId, runAttemptId: attempt.id, ordinal: scenario.recordedOrdinal }]),
        ])
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:${savedTurn.id}`),
                type: "provider-turn.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  ...savedTurn,
                  providerThreadId: thread.id,
                  nodeId: root.id,
                  nativeTurnRef: {
                    driver: fake.adapter.driver,
                    nativeId: cloudTask.taskId,
                    strength: "strong",
                  },
                  status: "running",
                  startedAt: originalStart,
                  completedAt: null,
                },
              },
            ],
          });
        const saved = yield* orchestrator.getThreadProjection(childId);
        if (scenario.recordedOrdinal === null) {
          const stop = yield* orchestrator
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:recovery-stop-untracked"),
              threadId: childId,
              runId: run.id,
            })
            .pipe(Effect.exit);
          assert.equal(stop._tag, "Failure");
          assert.deepEqual(yield* orchestrator.getThreadProjection(childId), saved);
          assert.equal(yield* Ref.get(fake.cancellations), 0);
        }
        // Both public Stop paths must refuse recorded cloud work before recovery attaches
        // a runtime, including unknown status and results awaiting terminal ingestion.
        const stopCommandId = CommandId.make("command:recovery-thread-stop-untracked");
        const stopError = yield* orchestrator
          .dispatch({ type: "thread.stop", commandId: stopCommandId, threadId: childId })
          .pipe(Effect.flip);
        assert.include(Cause.pretty(Cause.fail(stopError)), "Remote work may continue");
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(stopCommandId)).status,
          "rejected",
        );
        assert.deepEqual(yield* outbox.listByCommandId(stopCommandId), []);
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("env:cloud-recovery"),
          requestNamespace: "cloud-recovery",
          thread: {
            threadId: parentId,
            providerSessionId: "ps:recovery-parent",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const cancelled = yield* (yield* McpServer.McpServer)
          .callTool({
            name: "task_cancel",
            arguments: { taskId: task.id, clientRequestId: "stop-untracked" },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, cloudMcpClient),
          );
        assert.isTrue(cancelled.isError);
        assert.isUndefined(cancelled.structuredContent);
        const failureText = cancelled.content[0];
        assert.equal(failureText?.type, "text");
        if (failureText?.type !== "text") return;
        const failure = JSON.parse(failureText.text);
        assert.equal(failure.code, "task_not_cancellable");
        assert.include(failure.message, "Remote work may continue");
        assert.include(failure.message, "retry");
        const cancelCommandId = CommandId.make(
          "command:mcp:cloud-recovery:cancel-task:stop-untracked",
        );
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(cancelCommandId)).status,
          "rejected",
        );
        assert.deepEqual(yield* outbox.listByCommandId(cancelCommandId), []);
        const afterStops = yield* orchestrator.getThreadProjection(childId);
        assert.deepEqual(afterStops, saved);
        assert.isFalse(afterStops.turnItems.some((item) => item.type === "run_interrupt_request"));
        assert.equal(afterStops.runs[0]?.status, "running");
        assert.equal(afterStops.attempts[0]?.status, "running");
        assert.equal(afterStops.nodes.find((node) => node.id === root.id)?.status, "running");
        const parentAfterStops = yield* orchestrator.getThreadProjection(parentId);
        assert.deepEqual(parentAfterStops.subagents[0], task);
        assert.equal(yield* Ref.get(fake.cancellations), 0);
        const commandId = CommandId.make("command:recovery-reattach");
        const effectId = "effect:recovery-reattach";
        const afterSequence = yield* orchestrator.getThreadEventSequence(childId);
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId,
            threadId: childId,
            request: { type: "provider-turn.reattach", runId: run.id },
          },
        ]);
        // The original start effect sees the saved running run and does no work.
        yield* worker.drain();
        if (scenario.failure !== "none") {
          const retry = Option.getOrThrow(yield* outbox.get(effectId));
          assert.equal(retry.status, "pending");
          assert.equal(retry.attemptCount, 1);
          const afterFailure = yield* orchestrator.getThreadProjection(childId);
          assert.equal(afterFailure.runs[0]?.status, "running");
          assert.equal(afterFailure.attempts[0]?.status, "running");
          assert.equal(afterFailure.nodes.find((node) => node.id === root.id)?.status, "running");
          assert.deepEqual(afterFailure.providerThreads[0]?.cloudTask, cloudTask);
          assert.isFalse(
            afterFailure.turnItems.some((item) => item.id === `turn-item:cloud-result:${run.id}`),
          );
          assert.isFalse(
            afterFailure.visibleTurnItems.some(
              (row) => row.sourceItemId === `turn-item:cloud-result:${run.id}`,
            ),
          );
          assert.equal(
            afterFailure.messages.filter(
              (message) => message.id === `message:cloud-result:${run.id}`,
            ).length,
            0,
          );
          yield* TestClock.adjust("100 millis");
          yield* worker.drain();
        }
        assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "succeeded");
        assert.equal((yield* Ref.get(fake.current))?.providerTurnOrdinal, scenario.expectedOrdinal);
        const recovered = yield* orchestrator
          .streamStoredEventsFrom({
            threadId: childId,
            eventType: "provider-turn.updated",
            afterSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" && stored.event.payload.id === turnId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* Fiber.join(recovered);
        const attached = yield* orchestrator.getThreadProjection(childId);
        const turn = attached.providerTurns.find((candidate) => candidate.id === turnId)!;
        assert.equal(turn.ordinal, scenario.expectedOrdinal);
        assert.equal(
          DateTime.toEpochMillis(turn.startedAt!),
          DateTime.toEpochMillis(scenario.savedStart ? originalStart : adapterStart),
        );
        assert.equal(attached.runs[0]?.activeAttemptId, attempt.id);
        for (const recoveredStart of [
          attached.runs[0]!.startedAt,
          attached.attempts[0]!.startedAt,
          attached.nodes.find((node) => node.id === root.id)!.startedAt,
        ])
          assert.equal(
            recoveredStart === null ? null : DateTime.toEpochMillis(recoveredStart),
            startedAt === null ? null : DateTime.toEpochMillis(startedAt),
          );
        assert.equal(opens, scenario.failure === "open" ? 2 : 1);
        assert.equal(resumes, scenario.failure === "resume" ? 2 : 1);
        assert.equal(yield* Ref.get(fake.attachments), 1);
        assert.equal(yield* Ref.get(fake.creations), 0);
        assert.equal(yield* Ref.get(fake.submissions), 0);
        assert.equal(
          (yield* Ref.get(fake.current))?.providerThread.nativeThreadRef?.nativeId,
          "accepted-native-session",
        );
        assert.equal(
          (yield* Ref.get(fake.current))?.providerThread.cloudTask?.taskId,
          cloudTask.taskId,
        );
        yield* fake.finish();
        yield* Deferred.await(delivered);
        yield* worker.drain();
        const finished = yield* orchestrator.getThreadProjection(childId);
        assert.equal(finished.runs[0]?.status, "completed");
        const result = assertCloudResultItem(finished, run.id);
        assert.include(result.text, "Completed fake task");
        assert.include(result.text, "Cloud task: https://example.com/tasks/1");
        // A replayed recovery effect after settlement cannot attach or emit a second result.
        yield* outbox.enqueue([
          {
            id: "effect:recovery-reattach-replay",
            commandId: CommandId.make("command:recovery-reattach-replay"),
            threadId: childId,
            request: { type: "provider-turn.reattach", runId: run.id },
          },
        ]);
        yield* worker.drain();
        assert.deepEqual(
          assertCloudResultItem(yield* orchestrator.getThreadProjection(childId), run.id),
          result,
        );
        assert.equal(yield* Ref.get(fake.attachments), 1);
        assert.equal(
          finished.messages.filter((message) => message.id === `message:cloud-result:${run.id}`)
            .length,
          1,
        );
        assert.equal(offers.length, 1);
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.completionDelivery
            ?.state,
          "claimed",
        );
      }).pipe(Effect.provide(mcp));
    }).pipe(Effect.scoped),
);
