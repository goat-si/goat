import { expect, it } from "@effect/vitest";
import {
  ChannelDispatchTarget,
  ChannelInboundMessage,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelChildWork from "../../../channels/ChannelChildWork.ts";
import * as ChannelChildWorkStore from "../../../channels/channelChildWorkStore.ts";
import {
  bindingIdFor,
  childWorkCorrelationIdFor,
  contentHashFor,
  conversationIdFor,
  inputIdFor,
  taskEventIdFor,
} from "../../../channels/channelIds.ts";
import {
  prepareTransition,
  type ChannelTaskEventSpec,
} from "../../../channels/channelTaskWrites.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import { profileLayer } from "./handlers.testkit.ts";
import * as SshHandlers from "./handlers.ts";
import { SshToolkit } from "./tools.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const callerThreadId = ThreadId.make("ssh-caller");

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
  idempotencyKey: "T1:Ev-ssh-1",
  actor: { externalActorId: "U1" },
  replyAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1760000000.000100",
  },
  text: "Audit the release on box.",
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

const target = decodeTarget({
  environmentId: "env-1",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
});

const move = (taskId: ChannelTask["taskId"], spec: ChannelTaskEventSpec) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const stored = yield* ledger.getTask(taskId);
    if (stored === undefined) return yield* Effect.die("task missing");
    const prepared = prepareTransition(stored, spec, NOW, undefined);
    if (!prepared.ok) return yield* Effect.die("transition rejected: " + prepared.reason);
    yield* ledger.applyTaskEvent({
      owner: "ssh-cw-owner",
      write: prepared.write,
      deliveries: prepared.deliveries,
    });
  });

/** A channel task whose bound worker is the calling thread, so the launch admits as child work. */
const seedWorkerTask = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* ledger.claimOwnership({
    token: "ssh-cw-owner",
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
    owner: "ssh-cw-owner",
    inputId: input.inputId,
    receptionId: "ssh-cw-r" as never,
    readAt: NOW,
  });
  const task = decodeTask({
    taskId: "channel-task:ssh-cw-1",
    conversationId: input.conversationId,
    originBindingId: input.bindingId,
    originAddress: slackMessage.replyAddress,
    originInputId: input.inputId,
    requester,
    title: "Audit the release on box.",
    instruction: "Audit the release on box.",
    status: "received",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const event = decodeEvent({
    eventId: "channel-task-event:ssh-cw-1",
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
    owner: "ssh-cw-owner",
    inputId: input.inputId,
    receptionId: "ssh-cw-r" as never,
    replyText: "Starting.",
    decision: { replyText: "Starting.", action: { type: "report_only" } },
    createdTask: { task, event },
    deliveries: [],
    now: NOW,
  });
  yield* move(task.taskId, {
    type: "task.dispatch.claimed",
    payload: { generation: 1, target, leaseExpiresAt: NOW },
  });
  yield* move(task.taskId, {
    type: "task.worker.bound",
    payload: {
      worker: {
        environmentId: "env-1" as never,
        threadId: callerThreadId as never,
        runId: "run-1" as never,
        generation: 1,
      },
    },
  });
  return task.taskId;
});

interface LaunchCapture {
  readonly correlationId: string | undefined;
}

interface LaunchFailures {
  /** 0-based coordinator.launch call indexes that refuse before anything started remotely. */
  readonly refuseLaunchOnCalls?: ReadonlyArray<number>;
  /** 0-based validateLaunchAttachments call indexes that fail before any launch is attempted. */
  readonly failValidationOnCalls?: ReadonlyArray<number>;
  /** 0-based coordinator.launch call indexes that fail in beforeLaunch, before any remote write. */
  readonly failAuthorizeOnCalls?: ReadonlyArray<number>;
  readonly stopBeforeClaimOnCalls?: ReadonlyArray<number>;
  readonly stopDuringLaunchOnCalls?: ReadonlyArray<number>;
  readonly maxLanes?: number;
}

/** Runs goat_ssh_thread_launch with a channel-owned caller over one shared in-memory database. */
const launchFromWorker = (messages: ReadonlyArray<string>, failures: LaunchFailures = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launches: Array<LaunchCapture> = [];
      const rows: Array<{ readonly state: string; readonly remoteThreadId: string | null }> = [];
      const duringLaunchStates: Array<ReadonlyArray<string>> = [];
      let launchCalls = 0;
      let validationCalls = 0;
      const caller = {
        id: callerThreadId,
        title: "Bot worker",
        projectId: ProjectId.make("caller-project"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        activeRunId: "active-run",
        archivedAt: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell;
      const remoteResult: SshRemoteDispatch.SshLaunchResult = {
        host: "box",
        cwd: "/remote/project",
        projectId: "remote-project",
        projectCreated: false,
        threadId: "remote-thread",
        runId: "remote-run",
        reportsSupported: true,
        workspaceStrategy: { type: "root" },
        runtimeMode: "full-access",
        remoteServerKind: "external",
        notes: ["Remote launch succeeded."],
      };
      const channelStack = ChannelChildWork.layer.pipe(
        Layer.provideMerge(ChannelChildWorkStore.layer),
        Layer.provideMerge(ChannelLedger.layer),
        Layer.provideMerge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(caller),
          }),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      const scope = yield* Effect.scope;
      const channelDeps = yield* Layer.buildWithScope(channelStack, scope);
      const channelServices = Layer.succeedContext(channelDeps);
      const childWork = yield* ChannelChildWork.ChannelChildWork.pipe(Effect.provide(channelDeps));
      const childWorkStore = yield* ChannelChildWorkStore.ChannelChildWorkStore.pipe(
        Effect.provide(channelDeps),
      );
      const stopForCaller = Effect.gen(function* () {
        const ownership = yield* childWork.ownershipForCaller(callerThreadId);
        if (ownership._tag !== "worker") return yield* Effect.die("worker task missing");
        const taskId = ownership.task.taskId;
        yield* childWork.cancelForTask({
          taskId,
          generation: 1,
          stopEventId: taskEventIdFor(taskId, 99),
          attempt: 0,
          reason: "Stopped.",
        });
        return taskId;
      });
      const settings = PermissionSettings.layerTest(
        failures.maxLanes === undefined
          ? {}
          : {
              goatclaw: {
                enabled: true,
                defaultProfile: "ssh-test",
                profiles: {
                  "ssh-test": {
                    id: "ssh-test",
                    capabilities: ["threads.launch", "threads.remote"],
                    runtimeModeCeiling: "full-access",
                    maxLanes: failures.maxLanes,
                  },
                },
              },
            },
      );
      const dependencies = Layer.mergeAll(
        channelServices,
        failures.maxLanes === undefined
          ? profileLayer(undefined)
          : Profiles.layer.pipe(Layer.provide(channelServices), Layer.provide(settings)),
        settings,
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "session",
          thread: {
            threadId: callerThreadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("launcher-environment"),
            label: "studio",
          } as never),
        }),
        Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
        Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
        Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
        Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
        Layer.mock(SshHostSetup.SshHostSetup)({}),
        Layer.mock(CloudMachineService.CloudMachineService)({}),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          validateLaunchAttachments: (requested) => {
            const call = validationCalls;
            validationCalls += 1;
            const validation =
              failures.failValidationOnCalls?.includes(call) === true
                ? Effect.fail(
                    new SshRemoteDispatch.SshRemoteDispatchError({
                      reason: "invalid_request",
                      message: "attachment refused",
                    }),
                  )
                : Effect.succeed(requested);
            return failures.stopBeforeClaimOnCalls?.includes(call) === true
              ? stopForCaller.pipe(Effect.orDie, Effect.andThen(validation))
              : validation;
          },
        }),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
          launch: (input, beforeLaunch) => {
            const call = launchCalls;
            launchCalls += 1;
            launches.push({ correlationId: input.correlationId });
            if (failures.failAuthorizeOnCalls?.includes(call) === true) {
              return Effect.fail(
                new RemoteDispatchCoordinator.RemoteDispatchError({
                  stage: "authorize",
                  cause: new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: "The caller's permission profile no longer allows this launch.",
                  }),
                }),
              );
            }
            if (failures.refuseLaunchOnCalls?.includes(call) === true) {
              return Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "remote_refused",
                  message: "box refused the launch",
                  launchMayHaveStarted: false,
                }),
              );
            }
            return Effect.gen(function* () {
              if (failures.stopDuringLaunchOnCalls?.includes(call) === true) {
                const taskId = yield* stopForCaller.pipe(Effect.orDie);
                yield* move(taskId, {
                  type: "task.cancelled",
                  payload: { reason: "Stopped." },
                }).pipe(Effect.provide(channelDeps), Effect.orDie);
                yield* childWork.reconcile.pipe(Effect.orDie);
                const records = yield* childWorkStore.listForTask(taskId).pipe(Effect.orDie);
                duringLaunchStates.push(records.map((record) => record.state));
              }
              rows.push({ state: "running", remoteThreadId: remoteResult.threadId });
              yield* beforeLaunch;
              return {
                correlationId: input.correlationId ?? "rr-unrecorded",
                launch: remoteResult,
                reportsSupported: true,
              };
            });
          },
          get: (correlationId) =>
            Effect.sync(() => {
              const row = rows.at(0);
              return row === undefined
                ? null
                : ({
                    correlationId,
                    state: row.state,
                    remoteThreadId: row.remoteThreadId,
                  } as never);
            }),
        }),
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          register: (input) =>
            Effect.succeed(
              newLaunchWatch({
                ...input,
                host: input.host ?? null,
                incarnation: "ssh-watch",
                notifyWebhook: false,
                now: 0,
              }),
            ),
          watchExternal: () => Effect.succeed(null),
          resolveRoute: () => Effect.succeed({ notifyWebhook: false, webhookTarget: null }),
          releaseRoute: () => Effect.void,
        }),
      );
      const deps = yield* Layer.buildWithScope(dependencies, scope);
      const taskId = yield* seedWorkerTask.pipe(Effect.provide(deps));
      if (failures.maxLanes !== undefined) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${callerThreadId}, ${caller.projectId}, 'Bot worker', 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
        }).pipe(Effect.provide(deps));
      }
      const toolkit = yield* SshToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(
            Layer.provide(Layer.succeedContext(deps)),
          ),
        ),
      );
      const responses = [];
      for (const message of messages) {
        const collected = yield* toolkit
          .handle("goat_ssh_thread_launch", {
            host: "box",
            cwd: "/remote/project",
            title: "Audit",
            message,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(deps), Effect.exit);
        responses.push(Exit.isSuccess(collected) ? collected.value.at(-1)?.result : undefined);
      }
      const records = yield* ChannelChildWorkStore.ChannelChildWorkStore.pipe(
        Effect.flatMap((store) => store.listForTask(taskId)),
        Effect.provide(deps),
      );
      return { responses, launches, records, duringLaunchStates };
    }),
  );

it.effect("a channel-owned launch persists its record and binds the supplied correlation id", () =>
  Effect.gen(function* () {
    const { responses, launches, records } = yield* launchFromWorker(["Audit the release"]);
    expect(responses[0]).toMatchObject({ threadId: "remote-thread" });
    expect(launches).toHaveLength(1);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.state).toBe("bound");
    expect(record.surface).toBe("ssh_thread_launch");
    expect(launches[0]!.correlationId).toBe(childWorkCorrelationIdFor(record.childWorkId));
    expect(record.destination).toEqual({
      correlationId: childWorkCorrelationIdFor(record.childWorkId),
      host: "box",
    });
  }),
);

it.effect("an identical retry answers with the first attempt instead of launching twice", () =>
  Effect.gen(function* () {
    const { responses, launches, records } = yield* launchFromWorker([
      "Audit the release",
      "Audit the release",
    ]);
    expect(records).toHaveLength(1);
    expect(launches).toHaveLength(1);
    const correlationId = childWorkCorrelationIdFor(records[0]!.childWorkId);
    expect(responses[0]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[1]).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(responses[1])).toContain(correlationId);
  }),
);

it.effect("the descendant budget refuses a fifth distinct launch with capacity_exceeded", () =>
  Effect.gen(function* () {
    const { responses, launches, records } = yield* launchFromWorker([
      "Audit one",
      "Audit two",
      "Audit three",
      "Audit four",
      "Audit five",
    ]);
    expect(launches).toHaveLength(4);
    expect(records).toHaveLength(4);
    expect(responses[0]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[1]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[2]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[3]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[4]).toMatchObject({ code: "capacity_exceeded" });
  }),
);

it.effect("a refusal before the remote started returns the slot, so four more launches fit", () =>
  Effect.gen(function* () {
    const { responses, launches, records } = yield* launchFromWorker(
      ["Refused audit", "Audit one", "Audit two", "Audit three", "Audit four", "Audit five"],
      { refuseLaunchOnCalls: [0] },
    );
    expect(responses[0]).toMatchObject({ code: "orchestration_error" });
    expect(responses[1]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[2]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[3]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[4]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[5]).toMatchObject({ code: "capacity_exceeded" });
    expect(launches).toHaveLength(5);
    expect(records).toHaveLength(5);
    expect(records.filter((record) => record.state === "released")).toHaveLength(1);
    expect(records.filter((record) => record.state === "bound")).toHaveLength(4);
  }),
);

it.effect("a failure before the launch attempt releases the reservation", () =>
  Effect.gen(function* () {
    const { responses, launches, records } = yield* launchFromWorker(
      ["Bad attachment", "Audit one", "Audit two", "Audit three", "Audit four", "Audit five"],
      { failValidationOnCalls: [0] },
    );
    expect(responses[0]).toMatchObject({ code: "invalid_request" });
    expect(responses[1]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[2]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[3]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[4]).toMatchObject({ threadId: "remote-thread" });
    expect(responses[5]).toMatchObject({ code: "capacity_exceeded" });
    // The validation failure never reached the coordinator.
    expect(launches).toHaveLength(4);
    expect(records).toHaveLength(5);
    expect(records.filter((record) => record.state === "released")).toHaveLength(1);
    expect(records.filter((record) => record.state === "bound")).toHaveLength(4);
  }),
);

it.effect(
  "regression #1387: a task stop before the claim refuses the SSH launch and returns the slot",
  () =>
    Effect.gen(function* () {
      const { responses, launches, records } = yield* launchFromWorker(
        ["Stopped audit", "Audit one", "Audit two", "Audit three", "Audit four", "Audit five"],
        { stopBeforeClaimOnCalls: [0], maxLanes: 1 },
      );
      expect(responses[0]).toMatchObject({
        code: "orchestration_error",
        message: expect.stringMatching(/^The launch could not claim its reserved slot/),
      });
      expect(responses[1]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[2]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[3]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[4]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[5]).toMatchObject({ code: "capacity_exceeded" });
      expect(records).toHaveLength(5);
      const released = records.filter((record) => record.state === "released");
      const bound = records.filter((record) => record.state === "bound");
      expect(released).toHaveLength(1);
      expect(bound).toHaveLength(4);
      expect(launches).toHaveLength(4);
      expect(launches.map((launch) => launch.correlationId)).not.toContain(
        childWorkCorrelationIdFor(released[0]!.childWorkId),
      );
    }),
);

it.effect(
  "a task stop during the SSH launch keeps its record in flight until the launch binds it",
  () =>
    Effect.gen(function* () {
      const { responses, launches, records, duringLaunchStates } = yield* launchFromWorker(
        ["Audit the release"],
        { stopDuringLaunchOnCalls: [0] },
      );
      expect(duringLaunchStates).toEqual([["launched"]]);
      expect(responses[0]).toMatchObject({ threadId: "remote-thread" });
      expect(launches).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0]!.state).toBe("bound");
    }),
);

it.effect(
  "a retry of a safely released request conflicts instead of double-spending capacity",
  () =>
    Effect.gen(function* () {
      const { responses, launches, records } = yield* launchFromWorker(
        ["Refused audit", "Refused audit"],
        { refuseLaunchOnCalls: [0] },
      );
      expect(responses[0]).toMatchObject({ code: "orchestration_error" });
      expect(responses[1]).toMatchObject({ code: "conflict" });
      expect(JSON.stringify(responses[1])).toContain("released");
      expect(launches).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0]!.state).toBe("released");
    }),
);

it.effect(
  "a beforeLaunch refusal releases the slot and the caller keeps the original failure",
  () =>
    Effect.gen(function* () {
      const { responses, launches, records } = yield* launchFromWorker(
        ["Denied audit", "Audit one", "Audit two", "Audit three", "Audit four", "Audit five"],
        { failAuthorizeOnCalls: [0] },
      );
      // The coordinator's pre-send wrap is unwrapped back to the refusal the caller can act on.
      expect(responses[0]).toMatchObject({
        code: "capability_denied",
        message: "The caller's permission profile no longer allows this launch.",
      });
      expect(responses[1]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[2]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[3]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[4]).toMatchObject({ threadId: "remote-thread" });
      expect(responses[5]).toMatchObject({ code: "capacity_exceeded" });
      expect(launches).toHaveLength(5);
      expect(records).toHaveLength(5);
      expect(records.filter((record) => record.state === "released")).toHaveLength(1);
      expect(records.filter((record) => record.state === "bound")).toHaveLength(4);
    }),
);
