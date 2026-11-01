import { projectId, modelSelection } from "./threadLaunchInput.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ThreadProjectionJson,
  type ServerProvider,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../ThreadLaunchService.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "../ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export const otherProjectId = ProjectId.make("project:launch-other");
export const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
export const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

export const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as const;
export const claudeAdapter = {
  instanceId: claudeModelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly adapter?: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly prepared?: Deferred.Deferred<void>;
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  /** Folders that are gone from this machine. Without it, folders are not checked. */
  readonly missingPaths?: ReadonlySet<string>;
  /** How this machine writes a folder path; identity unless given. */
  readonly nativePath?: (path: string) => string;
}

export function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
    options.adapters ?? [options.adapter ?? adapter],
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const deleteLocalBranch = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      awaitRepositoryIdentity: () => Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      inspectExistingBranch: () => Effect.succeed(null),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      deleteLocalBranch,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeed(Option.none()),
      }),
    options.missingPaths === undefined && options.nativePath === undefined
      ? Layer.empty
      : Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: (path) =>
            options.missingPaths?.has(path)
              ? Effect.fail(
                  new WorkspacePaths.WorkspaceRootNotExistsError({
                    workspaceRoot: path,
                    normalizedWorkspaceRoot: path,
                  }),
                )
              : Effect.succeed(options.nativePath?.(path) ?? path),
        }),
  );
  const prepared = options.prepared;
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRegistry,
        layerExternalServices,
        prepared === undefined
          ? layerThreadManagement
          : Layer.effect(
              ThreadManagement.ThreadManagementService,
              Effect.gen(function* () {
                const service = yield* ThreadManagement.ThreadManagementService;
                return ThreadManagement.ThreadManagementService.of({
                  ...service,
                  dispatch: (command) =>
                    service
                      .dispatch(command)
                      .pipe(
                        Effect.tap(() =>
                          command.type === "prepared-run.release"
                            ? Deferred.succeed(prepared, undefined)
                            : Effect.void,
                        ),
                      ),
                });
              }),
            ).pipe(Layer.provide(layerThreadManagement)),
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreadManagement, layerProjectedProjects, layerExternalServices),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}
