import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as ThreadReplicaService from "../../ThreadReplicaService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
  type Project as ProjectRecord,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  splitStandingInstructions,
  standingInstructionsVersion,
} from "@goat/shared/standingInstructions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CloudSource from "../../../orchestration-v2/CloudTaskSourceService.ts";
import * as ProviderAdapters from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResults from "../../../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as CompletionWebhook from "../../completionWebhook.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadLaunchMcpService from "../../ThreadLaunchMcpService.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const localAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Launch admission does not open a provider session."),
};

/** Launch handlers resolve their service from the tool invocation context. */
const withLaunchService = <A, E, R>(dependencies: Layer.Layer<A, E, R>) =>
  ThreadLaunchMcpService.layer.pipe(
    Layer.provideMerge(Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({})),
    Layer.provide(
      Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
        get: () => Effect.succeed(localAdapter),
      }),
    ),
    Layer.provide(Layer.mock(CloudSource.CloudTaskSourceService)({})),
    Layer.provideMerge(dependencies),
  );

type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];
type ExternalWatch = Parameters<LaunchWatchService.LaunchWatchServiceShape["watchExternal"]>[0];
type Route = Parameters<LaunchWatchService.LaunchWatchServiceShape["releaseRoute"]>[0];

/**
 * Records the launch watches a handler asks for. A notifyTarget named "unknown" is refused like
 * an unconfigured one; any other name resolves to that named target.
 */
const launchWatches = (
  registrations: Array<Registration> = [],
  externalWatches: Array<ExternalWatch> = [],
  webhookWatchesExternal = false,
  released: Array<Route> = [],
  registerInterrupted = false,
) =>
  Layer.mock(LaunchWatchService.LaunchWatchService)({
    find: () => Effect.succeed(null),
    register: (input) =>
      registerInterrupted
        ? Effect.interrupt
        : Effect.sync(() => {
            registrations.push(input);
            return {} as never;
          }),
    watchExternal: (input) =>
      Effect.sync(() => {
        externalWatches.push(input);
        return webhookWatchesExternal ? ({} as never) : null;
      }),
    resolveRoute: (input) =>
      input.notifyTarget?.name === "unknown"
        ? Effect.fail(
            new CompletionWebhook.CompletionWebhookTargetError({
              message: 'Unknown notify target "unknown".',
            }),
          )
        : Effect.succeed({
            notifyWebhook: false,
            webhookTarget: { type: "named" as const, name: input.notifyTarget?.name ?? "" },
          }),
    releaseRoute: (route) => Effect.sync(() => void released.push(route)),
  }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})));

/** Launches from a T3 thread caller over mocks; returns what the handler did. */
const launchFromThread = (params: {
  readonly title: string;
  readonly message?: string;
  readonly notifyOnCompletion?: boolean;
  readonly notifyWebhook?: boolean;
  readonly notifyTarget?: { readonly name: string };
  readonly launchedBy?: ThreadLaunch.ThreadLaunchInput["launchedBy"];
  readonly standingInstructions?: boolean;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  /** An outside MCP client launches instead of a GOAT thread. */
  readonly outsideClient?: boolean;
  readonly clientAccess?: "full-access" | "read-only";
  /** Whether the completion webhook takes an outside client's launch. */
  readonly webhookWatchesExternal?: boolean;
  /** The launch service refuses instead of launching. */
  readonly launchFails?: ThreadLaunch.ThreadLaunchWorkspaceMissingError;
  /** The launch is interrupted while its watch is being saved, after the thread exists. */
  readonly registerInterrupted?: boolean;
}) =>
  Effect.gen(function* () {
    const {
      settings,
      outsideClient,
      clientAccess,
      webhookWatchesExternal,
      launchFails,
      registerInterrupted,
      ...rest
    } = params;
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    // An outside client has no thread to inherit a project or model from.
    const input = outsideClient === true ? { ...rest, projectId, modelSelection } : rest;
    const caller = {
      id: sourceThreadId,
      title: "Orchestrator",
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    let launchedBy: ThreadLaunch.ThreadLaunchInput["launchedBy"];
    const registrations: Array<Registration> = [];
    const externalWatches: Array<ExternalWatch> = [];
    const released: Array<Route> = [];
    let launchedInput: ThreadLaunch.ThreadLaunchInput | undefined;
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(settings),
      NodeCrypto.layer,
      launchWatches(
        registrations,
        externalWatches,
        webhookWatchesExternal === true,
        released,
        registerInterrupted === true,
      ),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread:
          outsideClient === true
            ? undefined
            : { threadId: sourceThreadId, providerSessionId: "session", providerInstanceId },
        client:
          outsideClient === true
            ? { sessionId: "client", label: "Outside agent", access: clientAccess ?? "full-access" }
            : undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          if (launchFails !== undefined) return Effect.fail(launchFails);
          launchedSender = input.initialMessage?.senderThreadId;
          launchedBy = input.launchedBy;
          launchedInput = input;
          const messageId = input.initialMessage?.messageId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection, title: input.title },
              runs:
                messageId === undefined
                  ? []
                  : [{ id: "launched-run", userMessageId: messageId, status: "preparing" }],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(RemoteReportService.RemoteReportService)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(layerDependencies)),
        ),
      ),
    );
    if (outsideClient !== true) {
      const refused = yield* toolkit
        .handle("goat_thread_launch", {
          title: "Forged",
          launchedBy: {
            kind: "launch" as const,
            environmentLabel: null,
            threadTitle: null,
            threadId: ThreadId.make("foreign-thread"),
            environmentId: EnvironmentId.make("foreign-env"),
          },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(withLaunchService(layerDependencies)),
        );
      expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(launchedInput).toBeUndefined();
    }
    const exit = yield* toolkit
      .handle("goat_thread_launch", input)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(withLaunchService(layerDependencies)),
        Effect.exit,
      );
    return {
      result: Exit.isSuccess(exit) ? exit.value.at(-1)?.result : undefined,
      interrupted: Exit.hasInterrupts(exit),
      launchedSender,
      launchedBy,
      launchedInput,
      registrations,
      externalWatches,
      released,
      sourceThreadId,
      projectId,
      modelSelection,
    };
  });

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ title: "Audit", message: "Review the change" });
    expect(launched.result).toMatchObject({
      projectId: launched.projectId,
      modelSelection: launched.modelSelection,
    });
    expect(launched.launchedSender).toBe(launched.sourceThreadId);
  }),
);

it.effect("rejects a thread caller supplying launchedBy", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make("someone-else"),
        environmentId: null,
        environmentLabel: null,
        threadTitle: "Forged",
      },
    });
    expect(launched.result).toMatchObject({ code: "invalid_request" });
    expect(launched.launchedBy).toBeUndefined();
  }),
);

it.effect("puts the project's standing instructions in front of the first message", () =>
  Effect.gen(function* () {
    const environment = yield* launchFromThread({
      title: "Audit",
      message: "Review the change",
      settings: { standingInstructions: "Use sol for subagents." },
    });
    expect(
      splitStandingInstructions(environment.launchedInput?.initialMessage?.text ?? ""),
    ).toEqual({
      block: {
        text: "Use sol for subagents.",
        version: standingInstructionsVersion("Use sol for subagents."),
      },
      text: "Review the change",
    });
    expect(environment.result).toMatchObject({
      standingInstructionsVersion: standingInstructionsVersion("Use sol for subagents."),
    });

    const project = yield* launchFromThread({
      title: "Audit",
      message: "Review the change",
      settings: {
        standingInstructions: "Use sol for subagents.",
        projectSettingsOverrides: {
          [ProjectId.make("project")]: { standingInstructions: "One topic per PR." },
        },
      },
    });
    expect(
      splitStandingInstructions(project.launchedInput?.initialMessage?.text ?? "").block?.text,
    ).toBe("One topic per PR.");
  }),
);

it.effect("sends the message as written when the launch opts out or starts no run", () =>
  Effect.gen(function* () {
    const settings = { standingInstructions: "Use sol for subagents." };
    const optedOut = yield* launchFromThread({
      title: "Audit",
      message: "Review the change",
      standingInstructions: false,
      settings,
    });
    expect(optedOut.launchedInput?.initialMessage?.text).toBe("Review the change");
    expect(optedOut.result).toMatchObject({ standingInstructionsVersion: null });

    const idle = yield* launchFromThread({ title: "Idle", settings });
    expect(idle.launchedInput?.initialMessage).toBeUndefined();
    expect(idle.result).toMatchObject({ standingInstructionsVersion: null });
  }),
);

it.effect("watches the launched thread's first run for the calling thread", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ title: "Audit", message: "Review the change" });
    expect(launched.result).toMatchObject({ runId: "launched-run", watching: true });
    expect(launched.registrations).toEqual([
      expect.objectContaining({
        launcherThreadId: launched.sourceThreadId,
        host: null,
        projectId: launched.projectId,
        title: "Audit",
        runId: "launched-run",
        notifyWebhook: false,
      }),
    ]);
    const opted = yield* launchFromThread({ title: "Audit", message: "Go", notifyWebhook: true });
    expect(opted.registrations).toEqual([expect.objectContaining({ notifyWebhook: true })]);
  }),
);

it.effect("records a dormant watch for an idle launch, and none when the caller opts out", () =>
  Effect.gen(function* () {
    const idle = yield* launchFromThread({ title: "Idle" });
    expect(idle.registrations).toEqual([expect.objectContaining({ runId: null })]);

    const optedOut = yield* launchFromThread({
      title: "Audit",
      message: "Review the change",
      notifyOnCompletion: false,
    });
    expect(optedOut.result).toMatchObject({ runId: "launched-run", watching: false });
    expect(optedOut.registrations).toEqual([]);
  }),
);

it.effect("leaves an outside client's launch unwatched while the webhook does not take it", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      outsideClient: true,
    });
    expect(launched.result).toMatchObject({ runId: "launched-run", watching: false });
    expect(launched.registrations).toEqual([]);
    expect(launched.externalWatches).toEqual([
      expect.objectContaining({ route: { notifyWebhook: false, webhookTarget: null } }),
    ]);
  }),
);

it.effect("watches an outside client's launch for the completion webhook", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyWebhook: true,
      outsideClient: true,
      webhookWatchesExternal: true,
    });
    expect(launched.result).toMatchObject({ runId: "launched-run", watching: true });
    expect(launched.registrations).toEqual([]);
    expect(launched.externalWatches).toEqual([
      {
        // The watch belongs to the launching client alone.
        owner: "session",
        host: null,
        threadId: expect.any(String),
        projectId: launched.projectId,
        title: "Audit",
        runId: "launched-run",
        ceiling: "full-access",
        route: { notifyWebhook: true, webhookTarget: null },
      },
    ]);

    // An idle launch has no run to report, and opting out of notifications wins.
    const idle = yield* launchFromThread({
      title: "Idle",
      notifyWebhook: true,
      outsideClient: true,
      webhookWatchesExternal: true,
    });
    const optedOut = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyWebhook: true,
      notifyOnCompletion: false,
      outsideClient: true,
      webhookWatchesExternal: true,
    });
    for (const launch of [idle, optedOut]) {
      expect(launch.result).toMatchObject({ watching: false });
      expect(launch.externalWatches).toEqual([]);
    }
  }),
);

it.effect("leaves a launch another machine's GOAT forwarded to that machine's watch", () =>
  Effect.gen(function* () {
    const forwarded = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyWebhook: true,
      outsideClient: true,
      webhookWatchesExternal: true,
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make("foreign-thread"),
        environmentId: EnvironmentId.make("foreign-env"),
        environmentLabel: "studio",
        threadTitle: "Orchestrator",
      },
    });
    expect(forwarded.launchedBy).toMatchObject({ threadId: "foreign-thread" });
    expect(forwarded.result).toMatchObject({ watching: false });
    expect(forwarded.externalWatches).toEqual([]);
  }),
);

it.effect("refuses a read-only outside client before launching or watching", () =>
  Effect.gen(function* () {
    const refused = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyWebhook: true,
      outsideClient: true,
      clientAccess: "read-only",
      webhookWatchesExternal: true,
    });
    expect(refused.result).toMatchObject({ code: "capability_denied" });
    expect(refused.launchedInput).toBeUndefined();
    expect(refused.externalWatches).toEqual([]);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      launchWatches(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(RemoteReportService.RemoteReportService)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(layerDependencies)),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"goat_thread_launch">>[1]) =>
      toolkit
        .handle("goat_thread_launch", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(withLaunchService(layerDependencies)),
        );

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      launchWatches(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(RemoteReportService.RemoteReportService)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(layerDependencies)),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"goat_project_create">>[1]) =>
      toolkit
        .handle("goat_project_create", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(withLaunchService(layerDependencies)),
        );

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    launchWatches(),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: input.overrideModel === undefined ? modelSelection : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(RemoteReportService.RemoteReportService)({}),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"goat_thread_launch">>[1]) =>
      toolkit
        .handle("goat_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
    expect(launched[0]?.launchedBy).toBeUndefined();

    // A launch GOAT forwarded from another machine names its launcher there.
    const forwardedLauncher = {
      kind: "launch" as const,
      threadId: ThreadId.make("remote-orchestrator"),
      environmentId: EnvironmentId.make("remote-environment"),
      environmentLabel: "studio",
      threadTitle: "Remote orchestrator",
    };
    yield* handle({ title: "Forwarded", projectId, launchedBy: forwardedLauncher });
    expect(launched[1]?.launchedBy).toEqual({ ...forwardedLauncher, via: "ssh_thread_launch" });
    launched.splice(1);

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a client starts at the project's default model and mode, capped at its ceiling", () =>
  Effect.gen(function* () {
    const launchWith = Effect.fn("test.launchWith")(function* (
      runtimeModeCeiling: RuntimeMode,
      defaultRuntimeMode: RuntimeMode,
      params: {
        readonly title: string;
        readonly message?: string;
        readonly runtimeMode?: RuntimeMode;
        readonly overrideModel?: ModelSelection;
      },
    ) {
      const { overrideModel, ...input } = params;
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, modelSelection, dependencies } = clientLaunchHarness({
        runtimeModeCeiling,
        defaultRuntimeMode,
        launched,
        ...(overrideModel === undefined ? {} : { overrideModel }),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(withLaunchService(dependencies)),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("goat_thread_launch", { ...input, projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
      return { result: result.at(-1)?.result, launched, projectId, modelSelection };
    });

    const belowCeiling = yield* launchWith("full-access", "approval-required", {
      title: "Fix",
      message: "Fix the bug",
    });
    expect(belowCeiling.result).toMatchObject({
      projectId: belowCeiling.projectId,
      modelSelection: belowCeiling.modelSelection,
    });
    expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");

    const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", { title: "Fix" });
    expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchWith("full-access", "approval-required", {
      title: "Fix",
      runtimeMode: "auto",
    });
    expect(requested.launched[0]?.runtimeMode).toBe("auto");

    const overrideModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-settings",
    };
    const fromSettings = yield* launchWith("full-access", "full-access", {
      title: "Fix",
      overrideModel,
    });
    expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("goat_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("goat_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect(
  "a launch onto a branch checked out elsewhere names that checkout and creates nothing",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
          Effect.fail(
            new ThreadLaunch.ThreadLaunchBranchError({
              projectId,
              projectTitle: "Client target",
              workspaceRoot: "/projects/client-target",
              branch: workspaceStrategy.branch ?? "",
              worktreePath: "/worktrees/lane",
              problem: "has 1 commit that origin/lane does not",
            }),
          ),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(withLaunchService(dependencies)),
          ),
        ),
      );
      const refused = (yield* toolkit
        .handle("goat_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef: "origin/lane", branch: "lane" },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(withLaunchService(dependencies)),
        )).at(-1)?.result;
      expect(refused).toMatchObject({ code: "invalid_request" });
      expect((refused as { message: string }).message).toBe(
        'Branch "lane" is already checked out at /worktrees/lane in project "Client target" and has 1 commit that origin/lane does not, so a new worktree cannot reuse it. No thread was created. Launch into that checkout with workspaceStrategy {"type":"existing_worktree","worktreePath":"/worktrees/lane","branch":"lane"}, or pass a branch name that does not exist yet.',
      );
      expect(launched).toHaveLength(0);
    }),
);

it.effect("lists and reads another machine's projects through that machine's own tools", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const remoteProject = {
      id: "project:remote",
      title: "Remote",
      workspaceRoot: "/srv/remote",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      launchWatches(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: { threadId: sourceThreadId, providerSessionId: "session", providerInstanceId },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: sourceThreadId,
            providerInstanceId,
            runtimeMode: "full-access",
            interactionMode: "plan",
            activeRunId: "active-run",
            archivedAt: null,
            deletedAt: null,
          } as OrchestrationV2ThreadShell),
      }),
      // This machine's projects are never read: any call would fail the test.
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(RemoteReportService.RemoteReportService)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-host-projects-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const dependencies = HostThreadsMcpService.layer.pipe(
      Layer.provide(layerNoFleetSync),
      Layer.provide(Layer.mock(ThreadResults.ThreadResultService)({})),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  calls.push(call);
                  return call.tool === "goat_project_list"
                    ? { projects: [remoteProject], nextCursor: null }
                    : remoteProject;
                }),
              ),
            ),
        }),
      ),
      Layer.provideMerge(layerDependencies),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );

    const listed = yield* toolkit
      .handle("goat_project_list", { host: "box", limit: 5 })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
    expect(listed.at(-1)?.result).toMatchObject({
      host: "box",
      projects: [{ id: "project:remote" }],
      nextCursor: null,
    });
    const read = yield* toolkit
      .handle("goat_project_read", { host: "box", projectId: ProjectId.make("project:remote") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
    expect(read.at(-1)?.result).toMatchObject({ id: "project:remote", host: "box" });
    expect(
      calls.map(({ host, tool, arguments: args, writes }) => [host, tool, args, writes]),
    ).toEqual([
      ["box", "goat_project_list", { limit: 5 }, false],
      ["box", "goat_project_read", { projectId: "project:remote" }, false],
    ]);
  }),
);

const reportBinding = {
  correlationId: "origin-correlation",
  originLabel: "origin",
  originThreadId: ThreadId.make("origin-thread"),
  readKeyHash: "1".repeat(64),
};
const reportLaunch = (options: {
  threadCaller?: boolean;
  failBind?: boolean;
  failLaunch?: boolean;
  interruptLaunch?: boolean;
  /** The launch created its thread before failing, so the thread exists afterwards. */
  acceptedBeforeFailure?: boolean;
}) =>
  Effect.gen(function* () {
    const callerId = ThreadId.make("caller");
    const operations: string[] = [];
    const bound: Array<{ threadId: ThreadId; input: typeof reportBinding }> = [];
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const base = clientLaunchHarness({ runtimeModeCeiling: "auto", launched });
    const { projectId, modelSelection } = base;
    const providerInstanceId = modelSelection.instanceId;
    // Later mock layers override the base services for these cases only.
    const dependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      base.dependencies,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("remote-environment"),
        requestNamespace: "report-launch",
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
        thread: options.threadCaller
          ? { threadId: callerId, providerSessionId: "session", providerInstanceId }
          : undefined,
        client: options.threadCaller
          ? undefined
          : { sessionId: "client", label: "origin", access: "auto" as const },
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            id !== callerId && !options.acceptedBeforeFailure
              ? null
              : ({
                  id,
                  projectId,
                  providerInstanceId,
                  modelSelection,
                  runtimeMode: "auto",
                  interactionMode: "default",
                  activeRunId: "active",
                  archivedAt: null,
                  deletedAt: null,
                } as OrchestrationV2ThreadShell),
          ),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          operations.push("launch");
          launched.push(input);
          if (options.interruptLaunch) return Effect.interrupt;
          return options.failLaunch
            ? Effect.fail(
                new ThreadLaunch.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: input.commandId,
                  projectId,
                  cause: new Error("fixture refusal"),
                }),
              )
            : Effect.succeed({
                threadId: input.threadId,
                resumed: false,
                projection: { thread: { id: input.threadId, projectId, modelSelection }, runs: [] },
              } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(RemoteReportService.RemoteReportService)({
        bind: (threadId, input) => {
          operations.push("bind");
          bound.push({ threadId, input });
          return options.failBind
            ? Effect.fail(new RemoteReportService.RemoteReportError({ reason: "storage" }))
            : Effect.void;
        },
        unbind: () =>
          Effect.sync(() => {
            operations.push("unbind");
          }),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const handle = (report?: typeof reportBinding) =>
      toolkit
        .handle("goat_thread_launch", {
          title: "Remote work",
          projectId,
          ...(report === undefined ? {} : { report }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
    return { operations, bound, launched, handle };
  });
it.effect("a thread caller cannot supply an origin binding", () =>
  Effect.gen(function* () {
    const fixture = yield* reportLaunch({ threadCaller: true });
    const result = yield* fixture.handle(reportBinding);
    expect(result.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(fixture.operations).toEqual([]);
  }),
);
it.effect("an outside client binds before intake and echoes only correlationId", () =>
  Effect.gen(function* () {
    const fixture = yield* reportLaunch({});
    const result = (yield* fixture.handle(reportBinding)).at(-1)?.result;
    expect(fixture.operations).toEqual(["bind", "launch"]);
    expect(fixture.bound[0]?.threadId).toBe(fixture.launched[0]?.threadId);
    expect(fixture.bound[0]?.input).toEqual(reportBinding);
    expect(result).toMatchObject({
      report: { correlationId: reportBinding.correlationId },
      runId: null,
    });
    expect((result as { report: object }).report).toEqual({
      correlationId: reportBinding.correlationId,
    });
    // A binding never creates a first message or starts an intentionally idle launch.
    expect(fixture.launched[0]?.initialMessage).toBeUndefined();
  }),
);
it.effect("launch without a report remains unbound and omits the echo", () =>
  Effect.gen(function* () {
    const fixture = yield* reportLaunch({});
    const result = (yield* fixture.handle()).at(-1)?.result;
    expect(fixture.operations).toEqual(["launch"]);
    expect(result).not.toHaveProperty("report");
  }),
);
it.effect(
  "failed intake unbinds but failed binding never launches or deletes an existing binding",
  () =>
    Effect.gen(function* () {
      const failedLaunch = yield* reportLaunch({ failLaunch: true });
      expect((yield* failedLaunch.handle(reportBinding)).at(-1)?.result).toMatchObject({
        code: "orchestration_error",
      });
      expect(failedLaunch.operations).toEqual(["bind", "launch", "unbind"]);
      const failedBind = yield* reportLaunch({ failBind: true });
      expect((yield* failedBind.handle(reportBinding)).at(-1)?.result).toMatchObject({
        code: "orchestration_error",
      });
      expect(failedBind.operations).toEqual(["bind"]);
    }),
);
it.effect("interrupted intake also unbinds the already committed report channel", () =>
  Effect.gen(function* () {
    const fixture = yield* reportLaunch({ interruptLaunch: true });
    yield* fixture.handle(reportBinding).pipe(Effect.exit);
    expect(fixture.operations).toEqual(["bind", "launch", "unbind"]);
  }),
);
it.effect("a launch that failed after creating its thread keeps the report channel", () =>
  Effect.gen(function* () {
    const failed = yield* reportLaunch({ failLaunch: true, acceptedBeforeFailure: true });
    expect((yield* failed.handle(reportBinding)).at(-1)?.result).toMatchObject({
      code: "orchestration_error",
    });
    expect(failed.operations).toEqual(["bind", "launch"]);
    const interrupted = yield* reportLaunch({ interruptLaunch: true, acceptedBeforeFailure: true });
    yield* interrupted.handle(reportBinding).pipe(Effect.exit);
    expect(interrupted.operations).toEqual(["bind", "launch"]);
  }),
);

it.effect("records the calling thread as the launcher, with or without a first message", () =>
  Effect.gen(function* () {
    const withMessage = yield* launchFromThread({ title: "Audit", message: "Review the change" });
    expect(withMessage.launchedInput?.launchedBy).toMatchObject({
      kind: "launch" as const,
      environmentLabel: null,
      threadTitle: "Orchestrator",
      threadId: withMessage.sourceThreadId,
      environmentId: null,
      via: "thread_launch",
    });
    const noPrompt = yield* launchFromThread({ title: "No prompt" });
    expect(noPrompt.launchedInput?.launchedBy).toMatchObject({
      kind: "launch" as const,
      environmentLabel: null,
      threadTitle: "Orchestrator",
      threadId: noPrompt.sourceThreadId,
      environmentId: null,
      via: "thread_launch",
    });
    expect(noPrompt.launchedInput?.initialMessage).toBeUndefined();
  }),
);

it.effect(
  "records an outside foreign launcher as ssh_thread_launch and rejects its own environment",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "full-access",
        launched,
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(withLaunchService(dependencies)),
          ),
        ),
      );
      const launcher = {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        threadId: ThreadId.make("foreign-thread"),
        environmentId: EnvironmentId.make("foreign-env"),
      };
      const handle = (environmentId: EnvironmentId | null, via?: "delegate_task") =>
        toolkit
          .handle("goat_thread_launch", {
            title: "Remote work",
            projectId,
            launchedBy: { ...launcher, environmentId, ...(via === undefined ? {} : { via }) },
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
      expect((yield* handle(EnvironmentId.make("environment"))).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
      expect((yield* handle(null)).at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(launched).toEqual([]);
      expect((yield* handle(launcher.environmentId)).at(-1)?.result).toMatchObject({ projectId });
      expect(launched[0]?.launchedBy).toEqual({ ...launcher, via: "ssh_thread_launch" });
      expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
      yield* handle(launcher.environmentId, "delegate_task");
      expect(launched[1]?.launchedBy).toEqual({ ...launcher, via: "delegate_task" });
    }),
);

it.effect("refuses an unknown notify target before creating a thread", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyTarget: { name: "unknown" },
    });
    expect(launched.result).toMatchObject({
      code: "invalid_request",
      message: 'Unknown notify target "unknown".',
    });
    expect(launched.launchedInput).toBeUndefined();
    expect(launched.registrations).toEqual([]);
  }),
);

it.effect("records a launch's notify target with its watch", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyTarget: { name: "bot-a" },
    });
    expect(launched.result).toMatchObject({ watching: true });
    expect(launched.registrations).toEqual([
      expect.objectContaining({
        notifyWebhook: false,
        webhookTarget: { type: "named", name: "bot-a" },
      }),
    ]);
    expect(launched.released).toEqual([]);
  }),
);

it.effect("releases a notify target whose launch records no watch", () =>
  Effect.gen(function* () {
    // An outside client's idle launch has no run, so nothing is watched.
    const launched = yield* launchFromThread({
      title: "Idle",
      notifyTarget: { name: "bot-a" },
      outsideClient: true,
      webhookWatchesExternal: true,
    });
    expect(launched.result).toMatchObject({ watching: false });
    expect(launched.released).toEqual([
      { notifyWebhook: false, webhookTarget: { type: "named", name: "bot-a" } },
    ]);
  }),
);

it.effect("releases a notify target when the launch is interrupted before its watch is saved", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      title: "Audit",
      message: "Go",
      notifyTarget: { name: "bot-a" },
      registerInterrupted: true,
    });
    expect(launched.interrupted).toBe(true);
    // The thread exists, but no watch holds the route, so what it kept is freed.
    expect(launched.launchedInput).toBeDefined();
    expect(launched.registrations).toEqual([]);
    expect(launched.released).toEqual([
      { notifyWebhook: false, webhookTarget: { type: "named", name: "bot-a" } },
    ]);
  }),
);
it.effect("tells the agent how to restore a missing project folder, and watches nothing", () =>
  Effect.gen(function* () {
    const launch = yield* launchFromThread({
      title: "Into a deleted checkout",
      message: "Go",
      launchFails: new ThreadLaunch.ThreadLaunchWorkspaceMissingError({
        projectId: ProjectId.make("project"),
        projectTitle: "Client target",
        kind: "project",
        path: "/projects/client-target",
        remoteUrl: "https://github.com/acme/client-target.git",
      }),
    });
    expect(launch.result).toMatchObject({
      code: "invalid_request",
      message:
        'Project "Client target" points at /projects/client-target, which does not exist on this machine. No thread was created. Clone it back with goat_call {path:"project.clone", args:{remoteUrl:"https://github.com/acme/client-target.git", destinationPath:"/projects/client-target"}}, or point the project at an existing checkout with goat_call {path:"project.update", args:{projectId:"project", workspaceRoot}}, then launch again.',
    });
    expect(launch.registrations).toEqual([]);
  }),
);
