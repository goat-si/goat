import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthSourceControlWriteScope,
  GitManagerError,
  WS_METHODS,
  WsRpcGroup,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

it.effect("a git action that fails partway still refreshes the repository status", () =>
  Effect.gen(function* () {
    const failure = new GitManagerError({ operation: "test", cwd: "/repo", detail: "push failed" });
    const refreshFailure = new GitManagerError({
      operation: "refresh",
      cwd: "/repo",
      detail: "refresh failed",
    });
    const refreshed = yield* Deferred.make<string>();
    const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const services = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        runStackedAction: () => Effect.fail(failure),
      }),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: (cwd) =>
          Deferred.succeed(refreshed, cwd).pipe(Effect.andThen(Effect.fail(refreshFailure))),
      }),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      layerConfigEnvironment,
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    );
    const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Exit" ? Queue.offer(exits, response.exit) : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("git-test"),
            subject: "git-test",
            principalKind: "person",
            method: "browser-session-cookie",
            scopes: [AuthSourceControlWriteScope],
          },
          {
            hasHost: Effect.succeed(false),
            attach: () => Stream.die("unused connection catalog"),
            respond: () => Effect.die("unused connection catalog"),
            invoke: () => Effect.die("unused connection catalog"),
          },
          { surface: "web" },
          {},
          yield* PreviewAutomationBroker.PreviewAutomationBroker,
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
        ).pipe(
          Layer.provide(services),
          Layer.merge(RpcAuthorization.layer([AuthSourceControlWriteScope])),
        ),
      ),
    );
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("git"),
      tag: WS_METHODS.gitRunStackedAction,
      payload: { actionId: "action", cwd: "/repo", action: "commit_push" },
      headers: Headers.empty,
    });
    const exit = yield* Queue.take(exits);
    assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, failure);
    assert.equal(yield* Deferred.await(refreshed), "/repo");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);
