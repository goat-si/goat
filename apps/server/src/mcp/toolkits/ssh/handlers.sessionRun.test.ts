import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChannelChildWork from "../../../channels/ChannelChildWork.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import { profileLayer } from "./handlers.testkit.ts";
import * as SshHandlers from "./handlers.ts";
import { SshToolkit } from "./tools.ts";

it.effect(
  "SSH admission receives the authenticated caller run and denies an unattributable run",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("goat-bot-session:ssh:1");
      const runId = RunId.make("run-a");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const admissions: Array<
        Parameters<ChannelChildWork.ChannelChildWork["Service"]["admit"]>[0]
      > = [];
      const dependencies = Layer.mergeAll(
        profileLayer(),
        PermissionSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("fixture"),
          requestNamespace: "session",
          thread: { threadId, runId, providerInstanceId, providerSessionId: "credential-a" },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ChannelChildWork.ChannelChildWork)({
          admit: (input) => {
            admissions.push(input);
            return Effect.fail(
              new ChannelChildWork.ChannelChildWorkError({
                reason: "run_not_attributable",
                detail: "Run A has ended.",
              }),
            );
          },
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("fixture"),
            label: "fixture",
          } as never),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId: ProjectId.make("project"),
              providerInstanceId,
              runtimeMode: "full-access",
              interactionMode: "default",
              archivedAt: null,
              deletedAt: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
        Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
        Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
        Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
        Layer.mock(SshHostSetup.SshHostSetup)({}),
        Layer.mock(CloudMachineService.CloudMachineService)({}),
        Layer.mock(LaunchWatchService.LaunchWatchService)({}),
      );
      const toolkit = yield* SshToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const response = yield* toolkit
        .handle("goat_ssh_thread_launch", {
          host: "box",
          cwd: "/remote/project",
          title: "Audit",
          message: "Review the change",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(admissions).toHaveLength(1);
      expect(admissions[0]?.callerRunId).toBe(runId);
      expect(response.at(-1)?.result).toMatchObject({
        code: "capability_denied",
        message: "Run A has ended.",
      });
    }),
);
