import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
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
  type ServerProvider,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
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
} from "../channels/channelIds.ts";
import { prepareTransition, type ChannelTaskEventSpec } from "../channels/channelTaskWrites.ts";
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

describe("OrchestratorMcpService delegate child work", () => {
  it.effect(
    "a dispatch failure returns the reservation only when no command receipt committed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
          const committed = yield* Ref.make<ReadonlyArray<string>>([]);
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: (commandId) =>
                Ref.get(committed).pipe(Effect.map((ids) => ids.includes(String(commandId)))),
              getThreadRecords: (threadId) =>
                Effect.succeed(threadId === callerThreadId ? parentProjection : childProjection),
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              assertProviderInstanceEnabled: () => Effect.void,
              dispatch: (command) =>
                Ref.update(dispatched, (ids) => [...ids, String(command.commandId)]).pipe(
                  // A command whose task commits leaves its accepted receipt behind, then
                  // fails afterward; the rest fail before committing anything.
                  Effect.andThen(
                    command.type === "delegated_task.request" && command.task.includes("commits")
                      ? Ref.update(committed, (ids) => [...ids, String(command.commandId)])
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
            ServerSettings.layerTest(),
          );
          const buildScope = yield* Effect.scope;
          // Built as production builds it: the channel layer arrives above the service's
          // construction, so admission only works through the per-call resolution.
          const serviceContext = yield* Layer.buildWithScope(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(layerNoFleetSync),
              Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
              Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
              Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
              Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
              Layer.provide(layerDependencies),
            ),
            buildScope,
          );
          const channelStack = ChannelChildWork.layer.pipe(
            Layer.provideMerge(ChannelChildWorkStore.layer),
            Layer.provideMerge(ChannelLedger.layer),
            Layer.provideMerge(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
            Layer.provideMerge(SqlitePersistence.layerMemory),
          );
          const channelContext = yield* Layer.buildWithScope(channelStack, buildScope);
          const taskId = yield* seedChannelWorkerTask.pipe(Effect.provide(channelContext));
          const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(serviceContext),
          );
          const callContext = Context.merge(serviceContext, channelContext);
          const delegate = (task: string) =>
            service
              .delegateTask(scope, {
                task,
                target: { driverKind: ProviderDriverKind.make("codex") },
                mode: "async",
              })
              .pipe(Effect.flip, Effect.provide(callContext));

          const preCommit = yield* delegate("alpha rejected");
          const committedOne = yield* delegate("bravo commits");
          const committedTwo = yield* delegate("charlie commits");
          assert.equal(preCommit.code, "orchestration_error");
          assert.equal(committedOne.code, "orchestration_error");
          assert.equal(committedTwo.code, "orchestration_error");
          // Only the pre-commit failure freed its slot, so the budget is full.
          const overflow = yield* delegate("delta never runs");
          assert.equal(overflow.code, "capacity_exceeded");
          assert.equal((yield* Ref.get(dispatched)).length, 3);

          const store = yield* ChannelChildWorkStore.ChannelChildWorkStore.pipe(
            Effect.provide(channelContext),
          );
          const records = yield* store.listForTask(taskId).pipe(Effect.provide(channelContext));
          assert.equal(records.length, 3);
          assert.equal(records.filter((record) => record.state === "released").length, 1);
          assert.equal(records.filter((record) => record.state === "launched").length, 2);
        }),
      ),
  );
});
