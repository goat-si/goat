import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  ChannelDispatchTarget,
  ChannelInboundMessage,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  type ServerProvider,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import * as ChannelChildWorkStore from "../channels/channelChildWorkStore.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import {
  bindingIdFor,
  contentHashFor,
  conversationIdFor,
  inputIdFor,
  taskEventIdFor,
} from "../channels/channelIds.ts";
import { prepareTransition, type ChannelTaskEventSpec } from "../channels/channelTaskWrites.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const callerThreadId = ThreadId.make("thread:oms-cw-parent");
const parentRunId = RunId.make("run:oms-cw-parent");
const parentNodeId = NodeId.make("node:oms-cw-root");
const projectId = ProjectId.make("project:oms-cw");
const codexInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: codexInstanceId, model: "gpt-5.4" };

const decodeMessage = Schema.decodeUnknownSync(ChannelInboundMessage);
const decodeRequester = Schema.decodeUnknownSync(ChannelRequester);
const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const decodeTarget = Schema.decodeUnknownSync(ChannelDispatchTarget);

const slackMessage = decodeMessage({
  kind: "slack",
  connectionId: "slack-1",
  conversationKey: "T1:C1:1760000000.000100",
  externalMessageId: "1760000000.000200",
  idempotencyKey: "T1:Ev-oms-cw-1",
  actor: { externalActorId: "U1" },
  replyAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1760000000.000100",
  },
  text: "Audit the release.",
  attachments: [],
  receivedAt: NOW,
  intent: "message",
});

const requester = decodeRequester({
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "slack",
  externalActorId: "U1",
  runtimeModeCeiling: "approval-required",
  grantedScopes: ["orchestration:read", "orchestration:operate"],
});

const channelTarget = decodeTarget({
  environmentId: "env-1",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
});

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:oms-cw"),
  requestNamespace: "provider-session:oms-cw",
  thread: {
    threadId: callerThreadId,
    providerSessionId: "provider-session:oms-cw",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const parentProjection = {
  thread: {
    id: callerThreadId,
    projectId,
    title: "Bot worker",
    createdBy: "user",
    creationSource: "web",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  runs: [
    {
      id: parentRunId,
      ordinal: 1,
      status: "running",
      rootNodeId: parentNodeId,
      providerInstanceId: codexInstanceId,
      modelSelection,
    },
  ],
  contextTransfers: [],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;

const childProjection = {
  thread: { id: ThreadId.make("thread:oms-cw-child") },
  runs: [],
  contextTransfers: [],
  messages: [],
  subagents: [],
  providerThreads: [],
  runtimeRequests: [],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;

const providerSnapshot: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const moveChannelTask = (taskId: ChannelTask["taskId"], spec: ChannelTaskEventSpec) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const stored = yield* ledger.getTask(taskId);
    if (stored === undefined) return yield* Effect.die("task missing");
    const prepared = prepareTransition(stored, spec, NOW, undefined);
    if (!prepared.ok) return yield* Effect.die("transition rejected: " + prepared.reason);
    yield* ledger.applyTaskEvent({
      owner: "oms-cw-owner",
      write: prepared.write,
      deliveries: prepared.deliveries,
    });
  });

/** A channel task whose bound worker is the calling thread, so delegate_task admits. */
const seedChannelWorkerTask = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* ledger.claimOwnership({
    token: "oms-cw-owner",
    now: NOW,
    staleBefore: "2026-10-11T23:59:30.000Z",
  });
  const conversationId = conversationIdFor({
    ownerId: "owner",
    kind: slackMessage.kind,
    connectionId: slackMessage.connectionId,
    conversationKey: slackMessage.conversationKey,
  });
  const input = yield* ledger.acceptInput({
    ownerId: "owner",
    inputId: inputIdFor({
      ownerId: "owner",
      kind: slackMessage.kind,
      connectionId: slackMessage.connectionId,
      idempotencyKey: slackMessage.idempotencyKey,
    }),
    conversationId,
    bindingId: bindingIdFor(conversationId, "root"),
    message: slackMessage,
    contentHash: contentHashFor(slackMessage),
    requester,
    acceptedAt: NOW,
  });
  yield* ledger.beginReception({
    owner: "oms-cw-owner",
    inputId: input.inputId,
    receptionId: "oms-cw-r" as never,
    readAt: NOW,
  });
  const task = decodeTask({
    taskId: "channel-task:oms-cw-1",
    conversationId: input.conversationId,
    originBindingId: input.bindingId,
    originAddress: slackMessage.replyAddress,
    originInputId: input.inputId,
    requester,
    title: "Audit the release.",
    instruction: "Audit the release.",
    status: "received",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const event = decodeEvent({
    eventId: "channel-task-event:oms-cw-1",
    sequence: 0,
    taskId: task.taskId,
    taskVersion: 1,
    occurredAt: NOW,
    actor: "system",
    type: "task.created",
    payload: {
      title: task.title,
      instruction: task.instruction,
      originInputId: input.inputId,
    },
  });
  yield* ledger.completeReception({
    owner: "oms-cw-owner",
    inputId: input.inputId,
    receptionId: "oms-cw-r" as never,
    replyText: "Starting.",
    decision: { replyText: "Starting.", action: { type: "report_only" } },
    createdTask: { task, event },
    deliveries: [],
    now: NOW,
  });
  yield* moveChannelTask(task.taskId, {
    type: "task.dispatch.claimed",
    payload: { generation: 1, target: channelTarget, leaseExpiresAt: NOW },
  });
  yield* moveChannelTask(task.taskId, {
    type: "task.worker.bound",
    payload: {
      worker: {
        environmentId: "env-1" as never,
        threadId: callerThreadId as never,
        runId: parentRunId as never,
        generation: 1,
      },
    },
  });
  return task.taskId;
});

const remoteCatalog: OrchestratorMcpCapabilitiesResult = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: codexInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: null,
      models: [{ id: "gpt-5.4" }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

const fixture = Effect.fn("childWorkTest.fixture")(function* (
  options: { readonly goatclaw?: boolean; readonly stopAt?: "receipt" | "fleet" } = {},
) {
  const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
  const accepted = yield* Ref.make<Readonly<Record<string, true>>>({});
  const rejectedReceipts = yield* Ref.make<Readonly<Record<string, true>>>({});
  const unreadable = yield* Ref.make<Readonly<Record<string, true>>>({});
  const remoteLaunches = yield* Ref.make(0);
  const buildScope = yield* Effect.scope;
  const channelStack = ChannelChildWork.layer.pipe(
    Layer.provideMerge(ChannelChildWorkStore.layer),
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provideMerge(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  // Per-call resolution in the service reads the ambient call context, which in
  // production is the whole server runtime; the receipt store rides alongside the
  // channel services here for the same reason. The service under test only reads
  // the receipt status, so the accepted fixture carries just that field.
  const receiptStoreLayer = Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
    getByCommandId: (commandId) =>
      Ref.get(unreadable).pipe(
        Effect.flatMap((ids) =>
          ids[String(commandId)] === true
            ? Effect.fail(new CommandReceiptStore.CommandReceiptStoreReadError({ commandId }))
            : Ref.get(accepted).pipe(
                Effect.map((done) =>
                  done[String(commandId)] === true
                    ? Option.some({
                        status: "accepted",
                      } as unknown as CommandReceiptStore.CommandReceiptV2)
                    : Option.none(),
                ),
              ),
        ),
      ),
  });
  const channelContext = yield* Layer.buildWithScope(
    Layer.mergeAll(channelStack, receiptStoreLayer),
    buildScope,
  );
  const taskId = yield* seedChannelWorkerTask.pipe(Effect.provide(channelContext));
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(channelContext));
  if (options.goatclaw) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${callerThreadId}, ${projectId}, 'Parent', 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
  }
  const stopped = yield* Ref.make(false);
  // Each mock consumes its hook once, so the next delegation can prove the lane returned.
  const stopBeforeClaim = Effect.fn("childWorkTest.stopBeforeClaim")(
    function* (point: "receipt" | "fleet") {
      if (options.stopAt !== point || (yield* Ref.getAndSet(stopped, true))) return;
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const records = yield* store.listForTask(taskId);
      assert.deepEqual(
        records.map((record) => record.state),
        ["reserved"],
      );
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const result = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId: taskEventIdFor(taskId, 99),
        attempt: 0,
        reason: "Stopped.",
      });
      assert.equal(result, "settled");
    },
    Effect.provide(channelContext),
    Effect.orDie,
  );
  const layerDependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      hasReceipt: (commandId) =>
        stopBeforeClaim("receipt").pipe(
          Effect.andThen(Effect.all([Ref.get(accepted), Ref.get(rejectedReceipts)])),
          Effect.map(
            ([done, refused]) =>
              done[String(commandId)] === true || refused[String(commandId)] === true,
          ),
        ),
      getThreadShell: () =>
        Effect.succeed(liveThreadShell(callerThreadId, { activeRunId: parentRunId })),
      getThreadRecords: (threadId) =>
        Effect.succeed(threadId === callerThreadId ? parentProjection : childProjection),
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      assertProviderInstanceEnabled: () => Effect.void,
      dispatch: (command) =>
        Ref.update(dispatched, (ids) => [...ids, String(command.commandId)]).pipe(
          // A committing command leaves an accepted receipt behind before failing; a
          // rejected one persists its rejection without committing; "unreadable" makes
          // the receipt read fail. The rest fail before committing anything.
          Effect.andThen(
            command.type === "delegated_task.request" && command.task.includes("commits")
              ? Ref.update(accepted, (ids) => ({
                  ...ids,
                  [String(command.commandId)]: true as const,
                }))
              : command.type === "delegated_task.request" && command.task.includes("rejected")
                ? Ref.update(rejectedReceipts, (ids) => ({
                    ...ids,
                    [String(command.commandId)]: true as const,
                  }))
                : Effect.void,
          ),
          Effect.andThen(
            command.type === "delegated_task.request" && command.task.includes("unreadable")
              ? Ref.update(unreadable, (ids) => ({
                  ...ids,
                  [String(command.commandId)]: true as const,
                }))
              : Effect.void,
          ),
          Effect.andThen(Effect.fail(new Error("simulated dispatch failure") as never)),
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([providerSnapshot]),
      refreshInstance: () => Effect.succeed([providerSnapshot]),
    }),
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed([codexInstanceId]),
        get: () =>
          Effect.succeed({
            instanceId: codexInstanceId,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
      }),
    ),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.succeed(SqlClient.SqlClient, sql),
    ServerSettings.layerTest({
      goatclaw: {
        enabled: options.goatclaw === true,
        defaultProfile: "owner",
        profiles: { owner: { ...BUILTIN_PERMISSION_PROFILES.owner!, maxLanes: 1 } },
      },
    }),
  );
  // Built as production builds it: the channel layer arrives above the service's
  // construction, so admission only works through the per-call resolution.
  const serviceContext = yield* Layer.buildWithScope(
    OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mock(FleetSync.GoatclawFleetSync)({
          ensure: () =>
            stopBeforeClaim("fleet").pipe(
              Effect.as({ sync: { state: "applied" as const }, enforcesCeilings: true }),
            ),
        }),
      ),
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
          launch: () =>
            Ref.update(remoteLaunches, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new RemoteDispatchCoordinator.RemoteDispatchError({
                    stage: "authorize",
                    cause: new Error("simulated remote dispatch failure"),
                  }),
                ),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            Effect.gen(function* () {
              yield* authorize;
              assert.equal(call.tool, "orchestrator_capabilities");
              return remoteCatalog;
            }),
        }),
      ),
      Layer.provide(layerDependencies),
    ),
    buildScope,
  );
  const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
    Effect.provide(serviceContext),
  );
  const callContext = Context.merge(serviceContext, channelContext);
  const delegate = (task: string, remote = false) =>
    service
      .delegateTask(scope, {
        task,
        target: {
          driverKind: ProviderDriverKind.make("codex"),
          ...(remote ? { host: "box" } : {}),
        },
        ...(remote ? { remote: { cwd: "/workspace/repo" } } : {}),
        mode: "async",
      } satisfies OrchestratorMcpDelegateTaskInput)
      .pipe(Effect.flip, Effect.provide(callContext));

  return {
    delegate,
    dispatched,
    remoteLaunches,
    records: () =>
      ChannelChildWorkStore.ChannelChildWorkStore.pipe(
        Effect.flatMap((store) => store.listForTask(taskId)),
        Effect.provide(channelContext),
      ),
    lanes: () => sql`SELECT id FROM goatclaw_lane_reservations`,
  };
});

describe("OrchestratorMcpService delegate child work", () => {
  it.effect(
    "a dispatch failure returns the reservation only when the receipt read shows no accepted receipt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const preCommit = yield* f.delegate("alpha vanishes");
          const committedOne = yield* f.delegate("bravo commits");
          const rejectedOne = yield* f.delegate("charlie rejected");
          const unreadableOne = yield* f.delegate("delta commits unreadable");
          assert.equal(preCommit.code, "orchestration_error");
          assert.equal(committedOne.code, "orchestration_error");
          assert.equal(rejectedOne.code, "orchestration_error");
          assert.equal(unreadableOne.code, "orchestration_error");
          // Only the never-committed and the rejected commands freed their slots, so the
          // accepted one and the unreadable one fill the budget.
          const overflow = yield* f.delegate("epsilon never runs");
          assert.equal(overflow.code, "capacity_exceeded");
          assert.equal((yield* Ref.get(f.dispatched)).length, 4);

          const records = yield* f.records();
          assert.equal(records.length, 4);
          assert.equal(records.filter((record) => record.state === "released").length, 2);
          assert.equal(records.filter((record) => record.state === "launched").length, 2);
        }),
      ),
  );

  it.effect("regression #1387: a task stop before the claim refuses a local delegation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture({ goatclaw: true, stopAt: "receipt" });
        const refused = yield* f.delegate("stopped local task");
        assert.equal(refused.code, "orchestration_error");
        assert.match(refused.message, /^The launch could not claim its reserved slot/u);
        assert.deepEqual(yield* Ref.get(f.dispatched), []);
        assert.deepEqual(
          (yield* f.records()).map((record) => record.state),
          ["released"],
        );
        assert.deepEqual(yield* f.lanes(), []);

        const next = yield* f.delegate("following local task");
        assert.equal(next.code, "orchestration_error");
        assert.match(next.message, /simulated dispatch failure/u);
        assert.equal((yield* Ref.get(f.dispatched)).length, 1);
      }),
    ),
  );

  it.effect(
    "regression #1387: a task stop before the claim refuses a remote delegation and returns its lane",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture({ goatclaw: true, stopAt: "fleet" });
          const refused = yield* f.delegate("stopped remote task", true);
          assert.equal(refused.code, "orchestration_error");
          assert.match(refused.message, /^The launch could not claim its reserved slot/u);
          assert.equal(yield* Ref.get(f.remoteLaunches), 0);
          assert.deepEqual(
            (yield* f.records()).map((record) => record.state),
            ["released"],
          );
          assert.deepEqual(yield* f.lanes(), []);

          const next = yield* f.delegate("following remote task", true);
          assert.equal(next.code, "orchestration_error");
          assert.equal(yield* Ref.get(f.remoteLaunches), 1);
        }),
      ),
  );
});
