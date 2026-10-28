import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadConfigurationInput,
  type OrchestratorMcpThreadConfigurationResult,
  type OrchestratorMcpThreadConfigureInput,
  type OrchestratorMcpThreadConfigureResult,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { hostFailure } from "./hostFailure.ts";
import {
  decodeConfiguration,
  decodeConfigure,
  decodeRemote,
  storeFailure,
  withoutHost,
} from "./hostThreadsResults.ts";
import * as HostToolAuthorization from "./HostToolAuthorization.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import { watchKeyOf } from "./launchWatchRearm.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";

export class HostThreadConfigurationMcpService extends Context.Service<
  HostThreadConfigurationMcpService,
  {
    readonly read: (
      scope: McpInvocationScope,
      input: OrchestratorMcpThreadConfigurationInput & {
        readonly host: string;
        readonly threadId: ThreadId;
      },
    ) => Effect.Effect<OrchestratorMcpThreadConfigurationResult, OrchestratorMcpFailure>;
    readonly configure: (
      scope: McpInvocationScope,
      input: OrchestratorMcpThreadConfigureInput & {
        readonly host: string;
        readonly threadId: ThreadId;
      },
    ) => Effect.Effect<OrchestratorMcpThreadConfigureResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/HostThreadConfigurationMcpService") {}

const make = Effect.gen(function* () {
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launchWatches = yield* LaunchWatchService.LaunchWatchService;

  const call = Effect.fn("HostThreadConfigurationMcpService.call")(function* <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly threadId: ThreadId;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) {
    const watch = yield* launchWatches
      .find(watchKeyOf(scope, input))
      .pipe(Effect.mapError(storeFailure));
    return yield* dispatch
      .callHostTool(
        {
          host: input.host,
          environmentId: watch?.sourceEnvironmentId ?? null,
          tool: input.tool,
          arguments: input.arguments,
          writes: input.writes,
          timeoutMs: 120_000,
          requireHostRoutable: true,
        },
        HostToolAuthorization.authorize(input.writes).pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      )
      .pipe(
        Effect.catchIf(
          (error) => error instanceof SshRemoteDispatch.SshRemoteDispatchError,
          (error) => Effect.fail(hostFailure(error)),
        ),
        Effect.flatMap(decodeRemote(decode, input.host, input.tool)),
        Effect.map((result) => ({ ...result, host: input.host })),
      );
  });

  return HostThreadConfigurationMcpService.of({
    read: Effect.fn("HostThreadConfigurationMcpService.read")((scope, input) =>
      call(
        scope,
        {
          host: input.host,
          threadId: input.threadId,
          tool: "goat_thread_configuration_read",
          arguments: withoutHost(input),
          writes: false,
        },
        decodeConfiguration,
      ),
    ),
    configure: Effect.fn("HostThreadConfigurationMcpService.configure")((scope, input) =>
      call(
        scope,
        {
          host: input.host,
          threadId: input.threadId,
          tool: "goat_thread_configure",
          arguments: withoutHost(input),
          writes: true,
        },
        decodeConfigure,
      ),
    ),
  });
});

export const layer = Layer.effect(HostThreadConfigurationMcpService, make);
