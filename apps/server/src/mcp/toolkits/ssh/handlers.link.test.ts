import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import { DisposableRouteGuard } from "../../../hub/disposable/DisposableRouteGuard.ts";
import * as LinkedHosts from "../../../linkedHosts/LinkedHosts.ts";
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
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as SshHandlers from "./handlers.ts";
import { scope, threadId } from "./handlers.testkit.ts";
import { SshToolkit } from "./tools.ts";

// Design section 6: an agent with a URL and pairing code for a disposable machine's GOAT is refused
// by LinkedHosts itself, so goat_host_link_create saves no route to it.
it.effect(
  "goat_host_link_create refuses a disposable machine's GOAT after the descriptor GET, sending nothing else and spending no code",
  () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      let writes = 0;
      const http = HttpClient.make((request) => {
        paths.push(new URL(request.url).pathname);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              environmentId: "env-box",
              label: "Disposable box",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.1.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          ),
        );
      });
      const linked = LinkedHosts.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.succeed(
            DisposableRouteGuard,
            DisposableRouteGuard.of({
              claim: () => Effect.undefined,
              refusal: (input, target) =>
                Effect.succeed(
                  input.environmentId === "env-box"
                    ? `${target} is a disposable machine`
                    : undefined,
                ),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeedNone,
            set: () =>
              Effect.sync(() => {
                writes += 1;
              }),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      );
      const dependencies = Layer.mergeAll(
        Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
        PermissionSettings.layerTest(),
        NodeCrypto.layer,
        linked,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          listHosts: () => Effect.succeed([]),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ label: "hub" } as never),
        }),
        Layer.mock(LaunchWatchService.LaunchWatchService)({}),
        Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
        Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
        Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
        Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
        Layer.mock(SshHostSetup.SshHostSetup)({}),
        Layer.mock(CloudMachineService.CloudMachineService)({}),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
      );
      const toolkit = yield* SshToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const responses = yield* toolkit
        .handle("goat_host_link_create", {
          name: "box",
          url: "https://box.example.ts.net",
          code: "pairing-code",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(JSON.stringify(responses.at(-1))).toContain("disposable machine");
      expect(paths).toEqual([GOAT_ENVIRONMENT_PATH]);
      expect(writes).toBe(0);
    }),
);
