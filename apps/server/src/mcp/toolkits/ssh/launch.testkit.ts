import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  type RepositoryLaunchSelection,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as FleetSync from "../../../goatclaw/FleetSync.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as SshHandlers from "./handlers.ts";
import { profileLayer } from "./handlers.testkit.ts";
import { SshToolkit } from "./tools.ts";

type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];
type ExternalWatch = Parameters<LaunchWatchService.LaunchWatchServiceShape["watchExternal"]>[0];
type Route = Parameters<LaunchWatchService.LaunchWatchServiceShape["releaseRoute"]>[0];

export type LaunchOptions = {
  readonly repository?: RepositoryLaunchSelection;
  readonly repositoryRefused?: boolean;
  readonly profile?: string;
  readonly notifyOnCompletion?: boolean;
  readonly notifyWebhook?: boolean;
  readonly reportsSupported?: boolean;
  readonly registerError?: LaunchWatchService.LaunchWatchStoreError;
  /** An outside MCP client launches instead of a GOAT thread. */
  readonly outsideClient?: boolean;
  /** The outside client's approved access; full-access by default. */
  readonly clientAccess?: "full-access" | "auto" | "read-only";
  /** Whether the completion webhook takes an outside client's launch. */
  readonly webhookWatchesExternal?: boolean;
  readonly workspace?: SshRemoteDispatch.SshLaunchInput["workspace"];
  /** Routes the launch to this named webhook target. */
  readonly notifyTarget?: { readonly name: string };
  /** The launch is interrupted while its watch is being saved, after the remote thread exists. */
  readonly registerInterrupted?: boolean;
  readonly goatclawRole?: "issue-sweeper";
  readonly references?: boolean;
  readonly dispatchError?: SshRemoteDispatch.SshRemoteDispatchError;
  readonly coordinationError?: RemoteDispatchCoordinator.RemoteDispatchError;
  /** What goatclaw fleet sync reports for the destination; absent leaves the service out. */
  readonly fleetReach?: FleetSync.HostReach;
};

/** Calls goat_ssh_thread_launch over mocks; returns its last response and what it asked for. */
export const launchRaw = (options: LaunchOptions = {}) =>
  Effect.gen(function* () {
    const callerThreadId = ThreadId.make("caller");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: callerThreadId,
      title: "Orchestrator",
      projectId: ProjectId.make("caller-project"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const registrations: Array<Registration> = [];
    const externalWatches: Array<ExternalWatch> = [];
    const released: Array<Route> = [];
    const launchInputs: Array<SshRemoteDispatch.SshLaunchInput> = [];
    const deliveries: Array<string> = [];
    const remoteResult: SshRemoteDispatch.SshLaunchResult = {
      host: "box",
      cwd: "/remote/project",
      projectId: "remote-project",
      projectCreated: false,
      threadId: "remote-thread",
      runId: "remote-run",
      reportsSupported: options.reportsSupported ?? true,
      workspaceStrategy: { type: "root" },
      runtimeMode: "full-access",
      remoteServerKind: "external",
      notes: ["Remote launch succeeded."],
    };
    const fleetReach = options.fleetReach;
    const dependencies = Layer.mergeAll(
      profileLayer(options.profile),
      PermissionSettings.layerTest(),
      NodeCrypto.layer,
      fleetReach === undefined
        ? Layer.empty
        : Layer.mock(FleetSync.GoatclawFleetSync)({
            ensure: () => Effect.succeed(fleetReach),
          }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread:
          options.outsideClient === true
            ? undefined
            : { threadId: callerThreadId, providerSessionId: "session", providerInstanceId },
        client:
          options.outsideClient === true
            ? {
                sessionId: "client",
                label: "Outside agent",
                access: options.clientAccess ?? "full-access",
              }
            : undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("launcher-environment"),
          label: "studio",
        } as never),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
      Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({
        prepareBrief: (_scope, input) =>
          Effect.succeed(
            (input.message ?? "") + "\nPINNED REFERENCE: source.ts at fixture-revision",
          ),
      }),
      Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({
        check: () =>
          options.repositoryRefused
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    "Repository launch refused: selected checkout missing; candidate: /repos/project",
                }),
              )
            : Effect.succeed(["Repository verified; dependency freshness unknown."]),
      }),
      Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
      Layer.mock(SshHostSetup.SshHostSetup)({}),
      Layer.mock(CloudMachineService.CloudMachineService)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        validateLaunchAttachments: (requested) => Effect.succeed(requested),
        launchThread: (input, beforeLaunch) => {
          launchInputs.push(input);
          const outcome: Effect.Effect<
            typeof remoteResult,
            SshRemoteDispatch.SshRemoteDispatchError
          > =
            options.dispatchError === undefined
              ? Effect.succeed(remoteResult)
              : Effect.fail(options.dispatchError);
          return beforeLaunch.pipe(Effect.andThen(outcome));
        },
      }),
      // A calling thread launches through the report coordinator, which wraps the SSH launch.
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        launch: (input, beforeLaunch) => {
          const failure = options.coordinationError ?? options.dispatchError;
          const outcome: Effect.Effect<
            { correlationId: string; launch: typeof remoteResult; reportsSupported: boolean },
            RemoteDispatchCoordinator.RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError
          > =
            failure === undefined
              ? Effect.succeed({
                  correlationId: "rr-test",
                  launch: remoteResult,
                  reportsSupported: true,
                })
              : Effect.fail(failure);
          return Effect.sync(() => {
            deliveries.push(input.delivery);
            launchInputs.push(input.launch);
          }).pipe(Effect.andThen(beforeLaunch), Effect.andThen(outcome));
        },
      }),
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        register: (input) =>
          Effect.gen(function* () {
            if (options.registerInterrupted === true) return yield* Effect.interrupt;
            registrations.push(input);
            if (options.registerError !== undefined) return yield* options.registerError;
            return newLaunchWatch({
              ...input,
              host: input.host ?? null,
              incarnation: "ssh-watch",
              notifyWebhook: input.notifyWebhook ?? false,
              now: 0,
            });
          }),
        watchExternal: (input) =>
          Effect.sync(() => {
            externalWatches.push(input);
            return options.webhookWatchesExternal === true
              ? newLaunchWatch({
                  ...input,
                  launcherThreadId: null,
                  host: input.host ?? null,
                  incarnation: "external-watch",
                  notifyWebhook: input.route.notifyWebhook,
                  webhookTarget: input.route.webhookTarget,
                  now: 0,
                })
              : null;
          }),
        resolveRoute: (input) =>
          Effect.succeed({
            notifyWebhook: false,
            webhookTarget: { type: "named" as const, name: input.notifyTarget?.name ?? "" },
          }),
        releaseRoute: (route) => Effect.sync(() => void released.push(route)),
      }),
    );
    const toolkit = yield* SshToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle("goat_ssh_thread_launch", {
        host: "box",
        cwd: "/remote/project",
        title: "Audit",
        message: "Review the change",
        ...(options.references
          ? {
              references: [
                {
                  mode: "snapshot" as const,
                  repositoryKey: "example.test/owner/repo",
                  files: ["source.ts"],
                },
              ],
            }
          : {}),
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        ...(options.notifyOnCompletion === undefined
          ? {}
          : { notifyOnCompletion: options.notifyOnCompletion }),
        ...(options.notifyWebhook === undefined ? {} : { notifyWebhook: options.notifyWebhook }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.notifyTarget === undefined ? {} : { notifyTarget: options.notifyTarget }),
        ...(options.goatclawRole === undefined ? {} : { goatclawRole: options.goatclawRole }),
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.exit);
    return {
      response: Exit.isSuccess(responses) ? responses.value.at(-1)?.result : undefined,
      interrupted: Exit.hasInterrupts(responses),
      registrations,
      externalWatches,
      released,
      launchInputs,
      deliveries,
      callerThreadId,
      remoteResult,
    };
  });

export const launchFromThread = (options: LaunchOptions = {}) =>
  Effect.gen(function* () {
    const { response, ...launched } = yield* launchRaw(options);
    if (response === undefined || !("notes" in response))
      return yield* Effect.die("Expected a successful SSH launch result.");
    return { result: response, ...launched };
  });
