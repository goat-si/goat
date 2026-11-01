import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as Settings from "../../serverSettings.ts";
import * as MaintenanceAudit from "../../maintenance/MaintenanceAudit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  RunId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  handoffSummary,
  type Handoff,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as Handoffs from "../../handoffs/Handoffs.ts";
import * as Diagnosis from "../../provider/ProviderDiagnosisRouting.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { liveThreadShell, idleThreadProjection } from "../../mcp/McpToolAccess.testkit.ts";

const now = DateTime.makeUnsafe(0);
const threadId = ThreadId.make("caller");
export const projection: OrchestrationV2ThreadProjection = {
  ...idleThreadProjection(liveThreadShell(threadId)),
  runs: [
    {
      id: RunId.make("run"),
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make("message"),
      rootNodeId: NodeId.make("node"),
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      memoryGrantCeiling: "none",
    },
  ],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
};
export const baseDependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(MaintenanceAudit.MaintenanceAudit, { append: () => Effect.void }),
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "test",
    legacyCookieName: undefined,
    listActive: () => Effect.succeed([]),
  }),
  Layer.mock(Handoffs.Handoffs)({
    completedSshContinuations: Effect.succeed([]),
    resolvedSshOutcomes: Effect.succeed([]),
    create: (input) =>
      Effect.succeed(
        handoffSummary({
          handoffId: TurnItemId.make("handoff:ssh"),
          kind: input.kind,
          title: input.title,
          reason: input.reason,
          requestedBy: input.requestedBy,
          target: input.target,
          dedupeKey: "test",
          state: "pending",
          expiresAt: input.expiresAt ?? null,
          createdAt: now,
          actor: { type: "agent", threadId: input.requestedBy.threadId },
        } satisfies Handoff),
      ),
  }),
  Layer.mock(Diagnosis.ProviderDiagnosisRouting)({
    diagnose: () => Effect.succeed({ checkedBy: "server", diagnoses: [] }),
  }),
  Layer.mock(Environment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("owner"),
      label: "Origin",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: false },
    }),
  }),
  Layer.mock(Threads.ThreadManagementService)({
    getThreadSnapshot: () => Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projection }),
    getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
  }),
);

export const dependencies = Layer.mergeAll(
  baseDependencies,
  Profiles.layer.pipe(Layer.provide(Settings.layerTest())),
);
