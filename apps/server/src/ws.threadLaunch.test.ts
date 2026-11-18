import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadLaunchInput,
  ProjectId,
  WsRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

const SESSION = {
  sessionId: AuthSessionId.make("launch-test"),
  subject: "launch-test",
  method: "browser-session-cookie",
  scopes: [AuthOrchestrationOperateScope],
  principalKind: "person",
} as const;
const decodeLaunchInput = Schema.decodeUnknownEffect(OrchestrationV2ThreadLaunchInput);

it.effect(
  "a client worktree launch on a branch it cannot reuse is refused before a thread exists",
  () =>
    Effect.gen(function* () {
      const refusal = new ThreadLaunchService.ThreadLaunchBranchError({
        projectId: ProjectId.make("project"),
        projectTitle: "Project",
        workspaceRoot: "/repo",
        branch: "feature",
        worktreePath: null,
        problem: "has 2 commits main does not",
      });
      const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
      const services = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        // Any use of thread management (creating the thread) dies through this empty mock.
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          checkWorktreeBase: () => Effect.fail(refusal),
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ enqueueCommand: (work) => work }),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ streamChanges: Stream.never }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
        Layer.mock(DirectEndpoints.DirectEndpoints)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        layerConfigEnvironment,
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      );
      const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
        ...WS_RPC_SERVER_OPTIONS,
        // A defect ends the client without an exit, so it is reported as one.
        onFromServer: (response) =>
          response._tag === "Exit"
            ? Queue.offer(exits, response.exit)
            : response._tag === "Defect"
              ? Queue.offer(exits, Exit.die(response.defect))
              : Effect.void,
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerWsRpc(
              SESSION,
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
            ).pipe(Layer.provide(services)),
            RpcAuthorization.layer(SESSION.scopes),
          ),
        ),
      );
      const payload = yield* decodeLaunchInput({
        commandId: "command-launch",
        projectId: "project",
        title: "Fix",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feature" },
      });
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId("launch"),
        tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
        payload,
        headers: Headers.empty,
      });
      const exit = yield* Queue.take(exits);
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              _tag: "Fail",
              error: {
                _tag: "OrchestrationV2ThreadLaunchError",
                commandId: payload.commandId,
                projectId: payload.projectId,
                message: refusal.message,
                cause: refusal,
              },
            },
          ],
        },
      });
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
