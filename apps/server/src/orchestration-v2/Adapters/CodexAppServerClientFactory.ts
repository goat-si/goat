import type {
  CodexSettings,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { AgentScope } from "@goat/shared/AgentScope";
import { resolveSpawnCommand } from "@goat/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { codexAppServerEnvironment } from "../../provider/CodexProvider.ts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import { CodexDetachedAppServers } from "../../provider/CodexDetachedAppServerLive.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly routeArgs?: ReadonlyArray<string>;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    ProviderAdapter.ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("goat/orchestration-v2/Adapters/CodexAppServerClientFactory") {}

export const makeCodexAppServerSpawnCommand = Effect.fn(
  "CodexAppServerClientFactory.makeSpawnCommand",
)(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly threadId?: string | undefined;
}) {
  const launch = yield* (yield* AgentScope).wrap({
    command: input.command,
    args: input.args,
    name: "codex",
    threadId: input.threadId,
    env: input.env,
    shared: true,
  });
  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
  });
  return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
    shell: spawnCommand.shell,
  });
});

export function makeCodexAppServerProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: redactCodexProtocolValue(boundProviderEventForLogging(event)),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

function redactCodexProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCodexProtocolValue);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") {
      return value;
    }
    if (/^Bearer\s+/i.test(value)) {
      return "[REDACTED]";
    }
    const trimmed = value.trim();
    if (
      !(
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      )
    ) {
      return value;
    }
    try {
      return JSON.stringify(
        redactCodexProtocolValue(boundProviderEventForLogging(JSON.parse(trimmed) as unknown)),
      );
    } catch {
      return value;
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveCodexProtocolKey(key) ? "[REDACTED]" : redactCodexProtocolValue(nested),
    ]),
  );
}

function isSensitiveCodexProtocolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

/** The resolved command and args for a detached launch (Unix only, so no shell wrapping). */
const makeCodexAppServerLaunch = Effect.fn("CodexAppServerClientFactory.makeLaunch")(
  function* (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly threadId?: string | undefined;
  }) {
    const launch = yield* (yield* AgentScope).wrap({
      command: input.command,
      args: input.args,
      name: "codex",
      threadId: input.threadId,
      env: input.env,
      shared: true,
    });
    const resolved = yield* resolveSpawnCommand(
      launch.command,
      launch.args,
      input.env === undefined ? {} : { env: input.env },
    );
    return { command: resolved.command, args: resolved.args };
  },
);

export const layerAppServerClientFactory: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderEventLoggers.ProviderEventLoggers
  | CodexDetachedAppServers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;
    const detached = yield* CodexDetachedAppServers;

    return CodexAppServerClientFactory.of({
      open: Effect.fn("CodexAppServerClientFactory.open")(function* (input) {
        const scope = yield* Scope.Scope;
        const openError = (cause: unknown) =>
          new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: CODEX_PROVIDER,
            providerSessionId: input.providerSessionId,
            cause,
          });
        // A process left by an earlier server run may still hold this provider's threads.
        yield* detached.ensureNotBlocked(input.instanceId).pipe(Effect.mapError(openError));
        const environment = {
          ...codexAppServerEnvironment(input.environment),
          ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
        };
        const launch = {
          command: input.settings.binaryPath || "codex",
          args: codexAppServerArgs(
            resolveCodexLaunchArgs(input.settings.launchArgs, input.environment),
            input.routeArgs,
          ),
          cwd: input.runtimePolicy.cwd ?? undefined,
          env: environment,
          threadId: input.threadId,
        };
        const protocolLogger = makeCodexAppServerProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const clientOptions: CodexClient.CodexAppServerClientOptions =
          protocolLogger === undefined
            ? {}
            : {
                logIncoming: true,
                logOutgoing: true,
                logger: protocolLogger,
              };
        if (detached.socketTransportEnabled) {
          const attempt = yield* Scope.fork(scope);
          const opened = yield* detached
            .open({
              instanceId: input.instanceId,
              cwd: launch.cwd,
              env: environment,
              command: (socketPath) =>
                makeCodexAppServerLaunch({
                  ...launch,
                  args: [...launch.args, "--listen", "unix://" + socketPath],
                }).pipe(
                  Effect.provideService(AgentScope, agentScope),
                  Effect.mapError(
                    (cause) =>
                      new CodexDetachedAppServerError({
                        detail: "Could not resolve the Codex command.",
                        cause,
                      }),
                  ),
                ),
            })
            .pipe(
              Effect.provideService(Scope.Scope, attempt),
              Effect.tapError((error) =>
                Scope.close(attempt, Exit.void).pipe(
                  Effect.andThen(
                    Effect.logWarning("Codex socket transport unavailable; using stdio", {
                      reason: error.message,
                    }),
                  ),
                ),
              ),
              Effect.option,
            );
          if (opened._tag === "Some") {
            const context = yield* Layer.build(
              CodexClient.layerMessageChannel(opened.value.channel, clientOptions),
            );
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }
        }
        const command = yield* makeCodexAppServerSpawnCommand(launch).pipe(
          Effect.provideService(AgentScope, agentScope),
        );
        const handle = yield* spawner
          .spawn(command)
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(openError));
        const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
      }),
    });
  }),
);
