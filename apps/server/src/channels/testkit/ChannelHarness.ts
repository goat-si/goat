/**
 * A channel core harness for tests: the GOAT bot thread is a real orchestrator thread whose
 * provider adapter refuses to run anything, worker threads are scripted (`WorkerWorld`), and the
 * reception model and Slack transport are fakes the test controls. Other lanes swap in their own
 * channel layer or Slack transport through `makeHarness` options.
 *
 * @module ChannelHarness
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChannelIngestInput,
  type ChannelOutboundMessage,
  type ChannelReceptionInput,
  type ChannelReceptionResult,
  ChannelGatewayError,
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadPullRequestLink,
  TextGenerationError,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as MemoryService from "../../memory/MemoryService.ts";
import * as MemorySyncService from "../../memory/MemorySyncService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import type { ChannelConnectionOwner } from "../ChannelIngressContext.ts";
import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLayers from "../ChannelLayers.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import { channelOwnerIdFor } from "../channelOwner.ts";

export const environmentId = EnvironmentId.make("environment:channel-test");
export const ownerId = channelOwnerIdFor(environmentId);
export const owner: ChannelConnectionOwner = {
  ownerId,
  principalId: "owner",
  displayName: "Owner",
  grantedScopes: ["orchestration:read", "orchestration:operate", "settings:write"],
  runtimeModeCeiling: "full-access",
};
export const projectId = ProjectId.make("project:channel-work");
export const scratchProjectId = ProjectId.make("project:scratch");
export const botThreadId = ThreadId.make("thread:goat-bot");
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
} as const;

const refusingAdapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("the GOAT bot must never start a provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Scripted worker threads: their runs, final assistant text, and background work. */
class WorkerWorld {
  readonly runs = new Map<string, Array<OrchestrationV2Run>>();
  readonly finalText = new Map<string, string>();
  readonly background = new Set<string>();
  readonly pullRequests = new Map<string, ReadonlyArray<ThreadPullRequestLink>>();
  readonly runtimeRequests = new Map<string, ReadonlyArray<OrchestrationV2RuntimeRequest>>();
  /** Approval prompts by request id, served as the thread's approval_request turn items. */
  readonly approvalPrompts = new Map<string, string>();
  /** Subagents a worker (or a subagent) thread started, by parent thread id. */
  readonly subagents = new Map<string, ReadonlyArray<OrchestrationV2Subagent>>();
  readonly shells = new Map<
    string,
    Partial<
      Pick<
        OrchestrationV2ThreadShell,
        "latestRunId" | "lastErrorClass" | "usageLimitResetAt" | "limitRecovery"
      >
    >
  >();
  readonly commands: Array<OrchestrationV2ServerCommand> = [];
  /** Worker threads whose shell read fails, and whose commands the orchestrator refuses. */
  readonly shellFailures = new Set<string>();
  readonly dispatchFailures = new Set<string>();
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
  /** Interrupts and subagent stops sent to worker threads, by thread id. */
  readonly interrupts: Array<string> = [];
  readonly subagentStops: Array<string> = [];
  /** Command ids the orchestrator refuses for good, as a persisted rejection would. */
  readonly rejectedCommands = new Set<string>();
  /** A worker thread's cloud task status, when it has one. */
  readonly cloudTasks = new Map<string, "running" | "submitting" | "completed">();
  /** Follow-ups that joined a running run, by message id, and the run they joined. */
  readonly steered = new Map<string, RunId>();
  /** Sends to fail, by message id, with the error the orchestrator would give. */
  readonly sendFailures = new Map<string, unknown>();
  /**
   * When the worker thread last changed. Unset reads as now, so a run stalls only when a test
   * freezes this behind the clock.
   */
  readonly activityAt = new Map<string, DateTime.Utc>();

  addRun(threadId: ThreadId, userMessageId: MessageId) {
    const existing = this.runs.get(threadId) ?? [];
    const run = {
      id: RunId.make("run:" + threadId + ":" + (existing.length + 1)),
      threadId,
      ordinal: existing.length + 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    } as unknown as OrchestrationV2Run;
    this.runs.set(threadId, [...existing, run]);
    return run;
  }

  setStatus(
    threadId: ThreadId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    text?: string,
  ) {
    const runs = this.runs.get(threadId) ?? [];
    this.runs.set(
      threadId,
      runs.map((run) =>
        run.ordinal === ordinal ? ({ ...run, status } as OrchestrationV2Run) : run,
      ),
    );
    const run = runs.find((candidate) => candidate.ordinal === ordinal);
    if (run !== undefined && text !== undefined) this.finalText.set(run.id, text);
  }

  latestRun(threadId: ThreadId) {
    return (this.runs.get(threadId) ?? []).at(-1);
  }
}

export type ReceptionScript = (
  input: ChannelReceptionInput,
) => Effect.Effect<ChannelReceptionResult, TextGenerationError>;

export const defaultScript: ReceptionScript = (input) => {
  const text = input.inputText ?? "";
  if (input.mode === "task_event") {
    return Effect.succeed({
      replyText: input.taskEvent?.summary ?? "",
      action: { type: "report_only" },
    });
  }
  if (text.startsWith("do:")) {
    return Effect.succeed({
      replyText: "On it.",
      action: {
        type: "create_task",
        title: text.slice(3).trim(),
        instruction: text.slice(3).trim(),
      },
    });
  }
  return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
};

export interface SlackSend {
  readonly message: ChannelOutboundMessage;
}

/**
 * A channel layer the harness accepts: at least the core services, needing at most what the core
 * needs. A layer that also outputs more, such as a live Slack runtime, fits.
 */
export type ChannelServicesLayer = Layer.Layer<
  Layer.Success<typeof ChannelLayers.layerServices>,
  Layer.Error<typeof ChannelLayers.layerServices>,
  Layer.Services<typeof ChannelLayers.layerServices>
>;

/** A machine whose SSH config lists no hosts: every task stays on this machine. */
const layerNoSshHosts = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
  listHosts: () => Effect.succeed([]),
  connectedHosts: Effect.succeed([]),
});

/** A provider account on this machine as placement sees it: signed in, with one weekly window. */
export interface FakeProviderInstance {
  readonly instanceId: string;
  readonly displayName?: string;
  /** Advertised model slugs; absent lists none, so any model counts as offered. */
  readonly models?: ReadonlyArray<string>;
  /** The weekly window's use; absent when the account reports no quota. */
  readonly weeklyUsedPercent?: number;
  readonly resetsAt?: string;
  readonly ready?: boolean;
  readonly missing?: boolean;
}

const fakeInstance = (instance: FakeProviderInstance) =>
  ({
    instanceId: ProviderInstanceId.make(instance.instanceId),
    driverKind: "codex",
    displayName: instance.displayName,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.map(DateTime.now, (now) => ({
        enabled: true,
        installed: true,
        status: instance.ready === false ? "error" : "ready",
        auth: { status: instance.ready === false ? "unauthenticated" : "authenticated" },
        // Absent means no models listed, so any model counts as offered.
        models: (instance.models ?? []).map((slug) => ({ slug })),
        ...(instance.weeklyUsedPercent === undefined
          ? {}
          : {
              usageLimits: {
                checkedAt: DateTime.formatIso(now),
                windows: [
                  {
                    id: "weekly",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: instance.weeklyUsedPercent,
                    ...(instance.resetsAt === undefined ? {} : { resetsAt: instance.resetsAt }),
                  },
                ],
              },
            }),
      })),
    },
  }) as never;

export function makeHarness(
  options: {
    readonly projects?: number;
    readonly repositoryIdentity?: import("@goat/contracts").RepositoryIdentity;
    /**
     * Provider accounts on this machine. By default only the configured one exists and it lists
     * no models, so any model counts as offered and placement has nothing to choose.
     */
    readonly providerInstances?: ReadonlyArray<FakeProviderInstance>;
    /** List the bot's own workspace among the projects, as a real server does. */
    readonly botWorkspace?: boolean;
    /**
     * Every project shell's default model: undefined keeps the shared modelSelection, a value
     * sets it, and null sets no default so resolution falls through to the server settings.
     */
    readonly shellDefaultModel?: ModelSelection | null;
    /** Settings overrides, including a publisher for live home changes. */
    readonly settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>;
    /** The channel services under test; defaults to the assembled core without background loops. */
    readonly channelsLayer?: ChannelServicesLayer;
    /** Register the fake Slack transport behind `slackSent` and `slackFailures` (default true). */
    readonly fakeSlackTransport?: boolean;
    /** Exercise durable launch receipts instead of the scripted worker launch. */
    readonly realWorkerLaunch?: boolean;
    /** Other machines over SSH; defaults to a machine that knows no SSH hosts. */
    readonly sshRemote?: Layer.Layer<SshRemoteDispatch.SshRemoteDispatch>;
    /** The state database; defaults to a fresh in-memory one. A file lets a test restart. */
    readonly databaseLayer?: typeof SqlitePersistence.layerMemory;
    /** GOAT memory for the bot's memory reads; absent by default, as in embeddings without it. */
    readonly memoryLayer?: Layer.Layer<
      MemoryService.MemoryService | MemorySyncService.MemorySyncService
    >;
  } = {},
) {
  const world = new WorkerWorld();
  const slackSent: Array<SlackSend> = [];
  const slackFailures: Array<ChannelGatewayError> = [];
  const script = { current: defaultScript };
  const providerCalls: string[] = [];
  const launch = {
    afterAccepted: (_input: ThreadLaunch.ThreadLaunchInput): Effect.Effect<void> => Effect.void,
  };

  const layerDatabase = options.databaseLayer ?? SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "channel-scenarios" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        ...refusingAdapter,
        openSession: () =>
          Effect.sync(() => providerCalls.push("openSession")).pipe(
            Effect.andThen(Effect.die("the GOAT bot must never start a provider session")),
          ),
      },
    ]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerSettings =
    options.settingsLayer ??
    ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
      providerInstances: Object.fromEntries(
        (options.providerInstances ?? []).map((instance) => [
          instance.instanceId,
          { driver: ProviderDriverKind.make("codex"), config: {}, enabled: true },
        ]),
      ),
    });
  const layerRealThreads = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provide(layerSettings),
  );
  const isWorker = (threadId: ThreadId) => world.runs.has(threadId);

  const layerThreads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...real,
        getThreadRecords: ((threadId: ThreadId, fields: never, filter: never) => {
          if (!isWorker(threadId)) return real.getThreadRecords(threadId, fields, filter);
          const runs = world.runs.get(threadId) ?? [];
          const messageRunIds = (
            filter as { readonly messageRunIds?: ReadonlyArray<string> } | undefined
          )?.messageRunIds;
          return Effect.gen(function* () {
            const updatedAt = world.activityAt.get(threadId) ?? (yield* DateTime.now);
            return {
              thread: {
                id: threadId,
                projectId,
                archivedAt: null,
                deletedAt: null,
                pullRequests: world.pullRequests.get(threadId) ?? [],
                updatedAt,
              },
              runs,
              runtimeRequests: world.runtimeRequests.get(threadId) ?? [],
              turnItems: (world.runtimeRequests.get(threadId) ?? []).flatMap((request) => {
                const prompt = world.approvalPrompts.get(request.id);
                return prompt === undefined
                  ? []
                  : [{ type: "approval_request", requestId: request.id, prompt }];
              }),
              providerThreads: [
                ...(world.background.has(threadId)
                  ? [{ pendingBackgroundTasks: [{ taskId: "background" }] }]
                  : []),
                ...(world.cloudTasks.has(threadId)
                  ? [{ cloudTask: { status: world.cloudTasks.get(threadId) } }]
                  : []),
              ],
              subagents: world.subagents.get(threadId) ?? [],
              messages: runs
                .filter((run) => messageRunIds === undefined || messageRunIds.includes(run.id))
                .flatMap((run) => {
                  const text = world.finalText.get(run.id);
                  return text === undefined
                    ? []
                    : [
                        {
                          role: "assistant",
                          text,
                          streaming: false,
                          runId: run.id,
                          createdAt: DateTime.makeUnsafe("2026-10-12T00:05:00.000Z"),
                        },
                      ];
                }),
            } as never;
          });
        }) as typeof real.getThreadRecords,
        getThreadShell: (threadId) => {
          if (!isWorker(threadId)) return real.getThreadShell(threadId);
          if (world.shellFailures.has(threadId)) {
            return Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: CommandId.make("shell-read"),
                commandType: "thread.shell.read",
              }),
            );
          }
          return Effect.succeed({
            id: threadId,
            latestRunId: world.latestRun(threadId)?.id ?? null,
            ...world.shells.get(threadId),
          } as OrchestrationV2ThreadShell);
        },
        dispatch: (command) => {
          if (!("threadId" in command) || !isWorker(command.threadId)) {
            return real.dispatch(command);
          }
          if (world.dispatchFailures.has(command.threadId)) {
            return Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
              }),
            );
          }
          if (world.rejectedCommands.has(command.commandId)) {
            return Effect.fail({ _tag: "OrchestratorCommandPreviouslyRejectedError" } as never);
          }
          // An answer resolves a pending request once; the orchestrator refuses a later one, and a
          // repeated command id returns what the first one did, as command receipts do.
          if (command.type === "runtime-request.respond") {
            const target = (world.runtimeRequests.get(command.threadId) ?? []).find(
              (request) => request.id === command.requestId,
            );
            const repeated = world.commands.some((sent) => sent.commandId === command.commandId);
            if (repeated) return Effect.succeed({ sequence: 0, storedEvents: [] });
            if (target?.status !== "pending") {
              return Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                }),
              );
            }
          }
          return Effect.sync(() => {
            world.commands.push(command);
            if (command.type === "runtime-request.respond") {
              const requests = world.runtimeRequests.get(command.threadId) ?? [];
              world.runtimeRequests.set(
                command.threadId,
                requests.map((request) =>
                  request.id === command.requestId
                    ? {
                        ...request,
                        status: "resolved" as const,
                        ...(command.decision === undefined ? {} : { decision: command.decision }),
                        ...(command.respondedBy === undefined
                          ? {}
                          : { respondedBy: command.respondedBy }),
                      }
                    : request,
                ),
              );
            }
            // A thread stop ends the running run and holds the queue, as the orchestrator does.
            if (command.type === "thread.stop") {
              world.interrupts.push(command.threadId);
              const latest = world.latestRun(command.threadId);
              if (latest !== undefined && latest.status === "running") {
                world.setStatus(command.threadId, latest.ordinal, "cancelled");
              }
            }
            if (command.type === "thread.metadata.update" && command.limitRecovery !== undefined) {
              const previous = world.shells.get(command.threadId);
              const recovery = command.limitRecovery;
              world.shells.set(command.threadId, {
                ...previous,
                limitRecovery:
                  recovery === null
                    ? null
                    : {
                        ...recovery,
                        autoResume:
                          recovery.autoResume ?? previous?.limitRecovery?.autoResume ?? false,
                      },
              });
            }
            return { sequence: 0, storedEvents: [] };
          });
        },
        sendToThread: (input) => {
          if (!isWorker(input.threadId)) return real.sendToThread(input);
          world.sends.push(input);
          const failure = world.sendFailures.get(input.messageId);
          if (failure !== undefined) return Effect.fail(failure as never);
          // "auto" joins a running run, as steering does, and starts the next run otherwise. A
          // repeated message id lands where it landed the first time, as command receipts do.
          const steeredInto = world.steered.get(input.messageId);
          const latest = world.latestRun(input.threadId);
          if (steeredInto !== undefined) {
            const run = (world.runs.get(input.threadId) ?? []).find((r) => r.id === steeredInto);
            return Effect.succeed({ run, delivery: "steered" } as never);
          }
          if (
            input.mode === "auto" &&
            latest?.status === "running" &&
            !(world.runs.get(input.threadId) ?? []).some(
              (run) => run.userMessageId === input.messageId,
            )
          ) {
            world.steered.set(input.messageId, latest.id);
            return Effect.succeed({ run: latest, delivery: "steered" } as never);
          }
          if (
            !(world.runs.get(input.threadId) ?? []).some(
              (run) => run.userMessageId === input.messageId,
            )
          ) {
            world.addRun(input.threadId, input.messageId);
          }
          const run = (world.runs.get(input.threadId) ?? []).find(
            (candidate) => candidate.userMessageId === input.messageId,
          );
          return Effect.succeed({ run, delivery: "started" } as never);
        },
        delegatedTaskResultPending: () => Effect.succeed(false),
        interruptThread: (input) => {
          if (!isWorker(input.threadId)) return real.interruptThread(input);
          world.interrupts.push(input.threadId);
          const latest = world.latestRun(input.threadId);
          if (latest !== undefined && latest.status === "running") {
            world.setStatus(input.threadId, latest.ordinal, "cancelled");
          }
          return Effect.succeed({ type: "no_active_run" } as const);
        },
        stopDelegatedTasks: (input) => {
          if (!isWorker(input.threadId)) return real.stopDelegatedTasks(input);
          world.subagentStops.push(input.threadId);
          return Effect.void;
        },
      });
    }),
  ).pipe(Layer.provide(layerRealThreads));

  const layerScriptedLaunch = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.sync(() => {
        world.launches.push(input);
        const threadId = input.threadId ?? ThreadId.make("thread:worker:" + input.commandId);
        // Same command, same thread and run: a retried launch finds what the first one made.
        if (!world.runs.has(threadId) && input.initialMessage?.messageId !== undefined) {
          world.addRun(threadId, input.initialMessage.messageId);
        }
        return {
          threadId,
          projection: { runs: world.runs.get(threadId) ?? [] },
          resumed: false,
        } as never;
      }),
  });

  const shellDefault =
    options.shellDefaultModel === undefined ? modelSelection : options.shellDefaultModel;
  const shells = [
    ...Array.from({ length: options.projects ?? 1 }, (_, index) => ({
      id: index === 0 ? projectId : ProjectId.make("project:channel-work-" + index),
      title: index === 0 ? "Channel work" : "Other work " + index,
      workspaceRoot: "/nonexistent/channel-work-" + index,
      defaultModelSelection: shellDefault,
      scripts: [],
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    })),
    ...(options.botWorkspace
      ? [
          {
            id: scratchProjectId,
            title: "Scratch",
            workspaceRoot: "/nonexistent/scratch",
            defaultModelSelection: shellDefault,
            scripts: [],
            createdAt: "2026-10-12T00:00:00.000Z",
            updatedAt: "2026-10-12T00:00:00.000Z",
          },
        ]
      : []),
  ];

  const layerExternal = Layer.mergeAll(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(options.repositoryIdentity ?? null),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateChannelReception: (input) => script.current(input.input),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Effect.succeed(shells as never),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      // Every instance exists and lists no models, so any model counts as offered.
      getInstance: (instanceId) => {
        const listed = options.providerInstances?.find(
          (instance) => instance.instanceId === instanceId,
        );
        return Effect.succeed(
          listed?.missing
            ? undefined
            : listed !== undefined
              ? fakeInstance(listed)
              : fakeInstance({ instanceId }),
        );
      },
      listInstances: Effect.succeed(
        (options.providerInstances ?? [{ instanceId: "codex" }])
          .filter((instance) => !instance.missing)
          .map(fakeInstance),
      ),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({ environmentId, label: "test-machine" } as never),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      ensureBotProject: Effect.succeed({ projectId: scratchProjectId }),
      folderForThread: () => Effect.succeed(Option.none()),
      isScratchProject: () => Effect.succeed(false),
    }),
    layerSettings,
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-channel-scenarios-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  const layerLaunchDependencies = Layer.mergeAll(
    layerExternal,
    layerThreads,
    CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
    IdAllocator.layer,
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
    ProviderRegistryMock.layer(),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            ...shells[0]!,
            repositoryIdentity: null,
            faviconPath: null,
            defaultThreadEnvMode: null,
            deletedAt: null,
          }),
        ),
    }),
  );
  const layerLaunch = Layer.effect(
    ThreadLaunch.ThreadLaunchService,
    Effect.gen(function* () {
      const service = yield* ThreadLaunch.ThreadLaunchService;
      return ThreadLaunch.ThreadLaunchService.of({
        ...service,
        launch: (input) =>
          service.launch(input).pipe(
            Effect.tap(() => {
              if (options.realWorkerLaunch) world.launches.push(input);
              return launch.afterAccepted(input);
            }),
          ),
      });
    }),
  ).pipe(
    Layer.provide(
      options.realWorkerLaunch
        ? ThreadLaunch.layer.pipe(Layer.provide(layerLaunchDependencies))
        : layerScriptedLaunch,
    ),
  );

  const layerChannels = (options.channelsLayer ?? ChannelLayers.layerServices).pipe(
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        quotaPool: Effect.succeed(undefined),
        projectProviders: (providers) => Effect.succeed(providers),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        layerLaunch,
        layerExternal,
        layerDatabase,
        IdAllocator.layer,
        options.sshRemote ?? layerNoSshHosts,
        options.memoryLayer ?? Layer.empty,
      ),
    ),
  );

  const layerSlack = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      yield* registry.register({
        kind: "slack",
        send: (message) => {
          const failure = slackFailures.shift();
          if (failure !== undefined) return Effect.fail(failure);
          slackSent.push({ message });
          return Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "2026-10-12T00:00:01.000Z",
          });
        },
      });
    }),
  );

  const layer = (options.fakeSlackTransport === false ? Layer.empty : layerSlack).pipe(
    Layer.provideMerge(layerChannels),
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(layerExternal),
    Layer.provideMerge(layerLaunch),
    Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(layerDatabase),
  );
  /** Removes a project from this machine's catalog, as if it was deleted while work waited. */
  const removeProject = (id: ProjectId) => {
    const index = shells.findIndex((shell) => shell.id === id);
    if (index !== -1) shells.splice(index, 1);
  };

  /** Renames a project in this machine's catalog. */
  const renameProject = (id: ProjectId, title: string) => {
    const index = shells.findIndex((shell) => shell.id === id);
    if (index !== -1) shells[index] = { ...shells[index]!, title };
  };

  return {
    layer,
    world,
    slackSent,
    slackFailures,
    script,
    launch,
    providerCalls,
    removeProject,
    renameProject,
  };
}

/** A new process owner over the caller's existing ledger and worker services, in its child scope. */
export const makeRuntime = Layer.build(Layer.fresh(ChannelRuntime.layer)).pipe(
  Effect.map((context) => Context.get(context, ChannelRuntime.ChannelRuntime)),
);

export const setupBot = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-goat-bot"),
    threadId: botThreadId,
    projectId: scratchProjectId,
    title: "GOAT bot",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  });
  yield* ledger.setBotIfAbsent({
    ownerId,
    bot: { environmentId, projectId: scratchProjectId, threadId: botThreadId },
    now: "2026-10-12T00:00:00.000Z",
  });
});

export const goatInput = (text: string, key: string): ChannelIngestInput => ({
  kind: "goat",
  connectionId: "goat",
  conversationKey: botThreadId,
  externalMessageId: key,
  idempotencyKey: key,
  actor: {},
  replyAddress: { kind: "goat", environmentId, threadId: botThreadId },
  text,
  attachments: [],
  receivedAt: "2026-10-12T00:00:00.000Z",
  intent: "message",
});

export const slackInput = (
  text: string,
  key: string,
  rootTs = "1760000000.000100",
  user = "U1",
): ChannelIngestInput => ({
  kind: "slack",
  connectionId: "slack-1",
  conversationKey: "T1:C1:" + rootTs,
  externalMessageId: key,
  idempotencyKey: "T1:" + key,
  actor: { externalActorId: user, displayName: "Slack user" },
  replyAddress: { kind: "slack", connectionId: "slack-1", teamId: "T1", channelId: "C1", rootTs },
  text,
  attachments: [],
  receivedAt: "2026-10-12T00:00:00.000Z",
  intent: "message",
});

export const rpcContext = { ...owner, caller: { type: "rpc" as const } };
export const slackContext = {
  ...owner,
  caller: { type: "transport" as const, kind: "slack" as const, connectionId: "slack-1" },
};

/** Links Slack user U1 the way a person would: a code from GOAT, sent to the bot. */
export const linkSlackUser = (user = "U1") =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      { connectionId: "slack-1", runtimeModeCeiling: "auto-accept-edits" },
      owner,
    );
    yield* gateway.linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "link-" + user,
        replyAddress: {
          kind: "slack",
          connectionId: "slack-1",
          teamId: "T1",
          channelId: "D1",
          rootTs: "1",
        },
      },
      slackContext,
    );
  });

export const botMessages = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads.getThreadRecords(botThreadId, ["messages", "runs", "turnItems"]);
  return records;
});

/** The newest task card in the bot; a GOAT Bot task's result lives there. */
export const latestCard = Effect.map(botMessages, (records) =>
  records.turnItems
    .flatMap((item) => (item.type === "notification" && item.ledgerTask ? [item.ledgerTask] : []))
    .at(-1),
);

export const onlyTask = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const page = yield* ledger.listTasks({ ownerId, limit: 10 });
  const [task, ...others] = page.tasks;
  if (task === undefined || others.length > 0) {
    return yield* Effect.die(new Error("expected exactly one task, found " + page.tasks.length));
  }
  return task;
});

export const resultsTo = (sent: ReadonlyArray<SlackSend>, kind: ChannelOutboundMessage["kind"]) =>
  sent.filter((send) => send.message.kind === kind);
