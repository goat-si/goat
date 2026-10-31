import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type Project as ProjectRecord,
  type RuntimeMode,
  type ServerProvider,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AttachmentLifecycle from "../../../assets/AttachmentLifecycle.testkit.ts";
import * as ServerConfig from "../../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CloudSource from "../../../orchestration-v2/CloudTaskSourceService.ts";
import * as ProviderAdapters from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as CompletionWebhook from "../../completionWebhook.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as ThreadLaunchMcpService from "../../ThreadLaunchMcpService.ts";
import * as ThreadReplicaService from "../../ThreadReplicaService.ts";

const localAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Launch admission does not open a provider session."),
};

/** Launch handlers resolve their service from the tool invocation context. */
export const withLaunchService = <A, E, R>(dependencies: Layer.Layer<A, E, R>) =>
  ThreadLaunchMcpService.layer.pipe(
    Layer.provideMerge(AttachmentLifecycle.layerFiles),
    Layer.provideMerge(Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({})),
    Layer.provide(
      Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
        get: () => Effect.succeed(localAdapter),
      }),
    ),
    Layer.provide(Layer.mock(CloudSource.CloudTaskSourceService)({})),
    Layer.provideMerge(dependencies),
  );

export type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];
export type ExternalWatch = Parameters<
  LaunchWatchService.LaunchWatchServiceShape["watchExternal"]
>[0];
export type Route = Parameters<LaunchWatchService.LaunchWatchServiceShape["releaseRoute"]>[0];

/**
 * Records the launch watches a handler asks for. A notifyTarget named "unknown" is refused like
 * an unconfigured one; any other name resolves to that named target.
 */
export const launchWatches = (
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

export const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  /** The provider catalog the launch reads; omitted, launches skip catalog checks. */
  readonly providers?: ReadonlyArray<ServerProvider>;
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
              title: launch.title,
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
    AttachmentLifecycle.layerFiles,
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
  const dependencies =
    input.providers === undefined
      ? layerDependencies
      : Layer.merge(
          layerDependencies,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(input.providers),
          }),
        );
  return { projectId, modelSelection, dependencies };
};
