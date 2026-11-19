import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  WS_METHODS,
  WsRpcGroup,
  VcsError,
  ReviewDiffPreviewError,
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  GitCommandError,
  type VcsError as VcsErrorType,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
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
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import { VcsCheckpointStorageError } from "./vcs/checkpointStorageError.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

const serveGitRpc = Effect.fn("test.serveGitRpc")(function* (
  services: Layer.Layer<
    ReviewService.ReviewService | VcsProvisioningService.VcsProvisioningService
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
          scopes: [AuthSourceControlWriteScope, AuthFilesystemReadScope],
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
        Layer.merge(RpcAuthorization.layer([AuthSourceControlWriteScope, AuthFilesystemReadScope])),
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

const previousVcs = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
const previousReview = Schema.Union([previousVcs, GitCommandError]);
it.effect.each([
  { tag: WS_METHODS.vcsInit, payload: { cwd: "/repo" }, schema: VcsError, previous: previousVcs },
  {
    tag: WS_METHODS.reviewGetDiffPreview,
    payload: { cwd: "/repo" },
    schema: ReviewDiffPreviewError,
    previous: previousReview,
  },
  {
    tag: WS_METHODS.reviewGetDiffFileContents,
    payload: {
      cwd: "/repo",
      sourceKind: "working-tree",
      changeType: "change",
      baseRef: null,
      headRef: null,
      oldPath: "a",
      newPath: "a",
    },
    schema: ReviewDiffPreviewError,
    previous: previousReview,
  },
] as const)("maps a checkpoint storage failure at $tag", ({ tag, payload, schema, previous }) =>
  withRpcSources(
    Effect.gen(function* () {
      const failure = new VcsCheckpointStorageError({
        operation: "checkpoint.capture",
        cwd: "/repo",
        stage: "publish",
        cause: "disk error",
      });
      const error = failure as unknown as VcsErrorType;
      const { server, exits } = yield* serveGitRpc(
        Layer.mergeAll(
          Layer.mock(VcsProvisioningService.VcsProvisioningService)({
            initRepository: () => Effect.fail(error),
          }),
          Layer.mock(ReviewService.ReviewService)({
            getDiffPreview: () => Effect.fail(error),
            getDiffFileContents: () => Effect.fail(error),
          }),
        ),
      );
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId("wire"),
        tag,
        payload,
        headers: Headers.empty,
      });
      const result = yield* Queue.take(exits);
      assert.isTrue(Exit.isFailure(result));
      if (!Exit.isFailure(result)) return;
      const mapped = Cause.squash(result.cause);
      const encoded = yield* Schema.encodeUnknownEffect(schema)(mapped);
      const decoded = yield* Schema.decodeEffect(previous)(encoded);
      assert.equal(decoded._tag, "VcsProcessExitError");
      assert.include(decoded.message, "publish checkpoint objects");
    }),
  ),
);
