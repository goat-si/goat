import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthSourceControlWriteScope,
  GitManagerError,
  WS_METHODS,
  WsRpcGroup,
  type VcsStatusStreamEvent,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
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
import { baseLocalStatus, layerTestFor } from "./vcs/vcsStatusBroadcaster.testkit.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

const serveGitRpc = Effect.fn("test.serveGitRpc")(function* (
  services: Layer.Layer<
    GitWorkflowService.GitWorkflowService | VcsStatusBroadcaster.VcsStatusBroadcaster
  >,
) {
  const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
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
        Layer.provide(
          Layer.mergeAll(
            layerUnusedConfigRpcServices,
            services,
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(UsageLimitSources.UsageLimitSources)({}),
            Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
            Layer.mock(DirectEndpoints.DirectEndpoints)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/unused",
            }),
            Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
            layerConfigEnvironment,
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
          ),
        ),
        Layer.merge(RpcAuthorization.layer([AuthSourceControlWriteScope])),
      ),
    ),
  );
  return { server, exits };
});

const withRpcSources = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  );

it.effect("a git action that fails partway still refreshes the repository status", () =>
  withRpcSources(
    Effect.gen(function* () {
      const failure = new GitManagerError({
        operation: "test",
        cwd: "/repo",
        detail: "push failed",
      });
      const refreshFailure = new GitManagerError({
        operation: "refresh",
        cwd: "/repo",
        detail: "refresh failed",
      });
      const refreshed = yield* Deferred.make<string>();
      const { server, exits } = yield* serveGitRpc(
        Layer.mergeAll(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            runStackedAction: () => Effect.fail(failure),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: (cwd) =>
              Deferred.succeed(refreshed, cwd).pipe(Effect.andThen(Effect.fail(refreshFailure))),
          }),
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
    }),
  ),
);

it.effect("removing a worktree tells its own status subscribers it is no longer a repository", () =>
  withRpcSources(
    Effect.gen(function* () {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      // vcs.removeWorktree removes only folders where GOAT creates worktrees.
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(config.worktreesDir, { recursive: true });
      const worktree = (yield* fileSystem.realPath(config.worktreesDir)) + "/repo/feature";
      const statusEvents = yield* Queue.unbounded<VcsStatusStreamEvent>();
      const status = Context.get(
        yield* Layer.build(layerTestFor(state)),
        VcsStatusBroadcaster.VcsStatusBroadcaster,
      );
      // The removed checkout's panel subscribes to its own path, not the main checkout's.
      yield* status.streamStatus({ cwd: worktree }).pipe(
        Stream.filter((event) => event._tag !== "remoteUpdated"),
        Stream.runForEach((event) => Queue.offer(statusEvents, event)),
        Effect.forkScoped,
      );
      assert.equal((yield* Queue.take(statusEvents))._tag, "snapshot");
      const { server, exits } = yield* serveGitRpc(
        Layer.mergeAll(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            removeWorktree: () =>
              Effect.sync(() => {
                state.currentLocalStatus = {
                  isRepo: false,
                  hasPrimaryRemote: false,
                  isDefaultRef: false,
                  refName: null,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                };
              }),
          }),
          Layer.succeed(VcsStatusBroadcaster.VcsStatusBroadcaster, status),
        ),
      );

      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId("remove"),
        tag: WS_METHODS.vcsRemoveWorktree,
        payload: { cwd: "/repo", path: worktree },
        headers: Headers.empty,
      });
      assert.isTrue(Exit.isSuccess(yield* Queue.take(exits)));
      const update = yield* Queue.take(statusEvents);
      assert.equal(update._tag === "localUpdated" ? update.local.isRepo : update._tag, false);
    }),
  ),
);
