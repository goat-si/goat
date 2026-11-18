import { fromRunner } from "@goat/provider-core/server/textGenerationOperations";
import { assert } from "@effect/vitest";
import * as Queue from "effect/Queue";
import type * as Orchestrator from "./Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import type * as EventSink from "./EventSink.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  CommandId,
  type ThreadId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type PullRequestDetail,
  SourceControlProviderKind,
  TurnItemId,
  type OrchestrationV2Run,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

export const layerPlatformTest = Layer.merge(
  DocumentText.layer.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

export const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-orchestration-v2-runtime-layer-",
});

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
export const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

export const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
export const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
export const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

export const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: fromRunner("fixture", () => Effect.die("Unexpected generation.")),
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;

export const antigravityInstanceId = ProviderInstanceId.make("antigravity_test");
const antigravityDriver = ProviderDriverKind.make("antigravity");
const antigravityProviderInstance = {
  ...providerInstance,
  instanceId: antigravityInstanceId,
  driverKind: antigravityDriver,
  continuationIdentity: { driverKind: antigravityDriver, continuationKey: "antigravity:test" },
  displayName: "Antigravity test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: antigravityInstanceId,
    driver: antigravityDriver,
    getCapabilities: () =>
      Effect.succeed({
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsNativeGoals: true },
      }),
  },
} satisfies ProviderInstance;

export const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance, antigravityProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([
      providerInstance,
      alternateProviderInstance,
      antigravityProviderInstance,
    ]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

export const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "goat-si/goat",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/goat-si/goat/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

export const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

export const moveProject = (projectId: ProjectId, workspaceRoot: string, updatedAt: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`move:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId, workspaceRoot, updatedAt },
    }),
  );

export const layerLegacyImportTest = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

export const writeProviderFailureForQueue = Effect.fn("writeProviderFailureForQueue")(function* (
  eventSink: EventSink.EventSinkV2["Service"],
  activeRun: OrchestrationV2Run & {
    readonly rootNodeId: NonNullable<OrchestrationV2Run["rootNodeId"]>;
  },
  failureClass: "provider_error" | "usage_limit",
) {
  const { threadId } = activeRun;
  const now = yield* DateTime.now;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${threadId}:error`),
        type: "turn-item.updated",
        threadId,
        runId: activeRun.id,
        nodeId: activeRun.rootNodeId,
        providerInstanceId: activeRun.providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`${threadId}:error`),
          type: "error",
          threadId,
          runId: activeRun.id,
          nodeId: activeRun.rootNodeId,
          providerThreadId: activeRun.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Provider failure",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: failureClass,
            message: "Provider failed.",
            code: "provider_failed",
            retryable: null,
            ...(failureClass === "usage_limit"
              ? { resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })) }
              : {}),
          },
        },
      },
      {
        id: EventId.make(`${threadId}:failed`),
        type: "run.updated",
        threadId,
        runId: activeRun.id,
        nodeId: activeRun.rootNodeId,
        providerInstanceId: activeRun.providerInstanceId,
        occurredAt: now,
        payload: { ...activeRun, status: "failed", completedAt: now },
      },
    ],
  });
});

export const dispatchBufferedQueueWake = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  wakeMessageId: MessageId,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:${wakeMessageId}`),
    threadId,
    messageId: wakeMessageId,
    text: "Background work completed.",
    attachments: [],
    createdBy: "agent",
    creationSource: "provider",
    dispatchMode: { type: "queue_after_active" },
    notification: {
      source: { kind: "background_task" },
      outcome: "completed",
      summary: "Work finished",
    },
  });

export const dispatchHeldAgentPrompt = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`${threadId}:agent`),
    threadId,
    messageId: MessageId.make(`${threadId}:agent`),
    text: "A queued agent prompt",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });

export const finishBufferedReplay = Effect.fn("finishBufferedReplay")(function* (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  sink: EventSink.EventSinkV2["Service"],
  wake: OrchestrationV2Run,
  promotedRunIds: Queue.Queue<OrchestrationV2Run["id"]>,
) {
  assert.equal(yield* Queue.take(promotedRunIds), wake.id);
  const { threadId } = wake;
  const markerMessageId = MessageId.make(`${threadId}:second-replay`);
  yield* dispatchBufferedQueueWake(orchestrator, threadId, markerMessageId);
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const agent = projection.runs.find((run) => run.userMessageId === `${threadId}:agent`);
  const marker = projection.runs.find((run) => run.userMessageId === markerMessageId);
  if (marker === undefined || agent?.queueHeld !== true)
    return yield* Effect.die("Missing held agent or replay marker");
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:replayed`),
        type: "run.updated",
        threadId,
        runId: wake.id,
        occurredAt: now,
        payload: {
          ...wake,
          status: "completed",
          startedAt: wake.startedAt ?? now,
          completedAt: now,
        },
      },
    ],
  });
  assert.equal(yield* Queue.take(promotedRunIds), marker.id);
  const after = yield* orchestrator.getThreadProjection(threadId);
  assert.isTrue(after.runs.find((run) => run.id === agent.id)?.queueHeld);
});

export const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      awaitRepositoryIdentity: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);
