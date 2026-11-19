import { renameClaudeSession } from "./ClaudeSessionRenameControl.ts";
import { withoutClaudeCanUseToolShadowedWarning } from "./ClaudeSdkWarning.ts";
import { interruptedResumeOptions } from "./ClaudeInterruptedResume.ts";
import {
  forkSession as forkClaudeSession,
  type ForkSessionOptions,
  type ForkSessionResult,
  getSessionMessages,
  getSubagentMessages,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type Query as ClaudeQuery,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess as ClaudeSpawnedProcess,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawnClaudeProcessGroup, spawnClaudeWindowsProcess } from "./ClaudeProcessSpawn.ts";
import { watchClaudeProcess } from "./ClaudeProcessSpawn.ts";
import { makeClaudeDescendantSampler, readClaudeProcessTable } from "./ClaudeDescendants.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderProcesses from "../../process/providerProcesses.ts";
import { lastClaudeTranscriptModel } from "./ClaudeForkedSkillModel.ts";
import { AgentScope } from "@goat/shared/AgentScope";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  type ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { spawnAndCollect } from "@goat/provider-core/server/snapshotProbe";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  CLAUDE_ROOT_REFUSAL,
  CLAUDE_CONVERSATION_NOT_FOUND,
  ClaudeConversationNotFoundError,
  ClaudeAgentSdkQueryRunnerError,
  ClaudeCodeRootRefusalError,
  ClaudeMcpRegistrationTimeoutError,
  isClaudeMcpRegistrationTimeoutError,
  queryRunnerError,
} from "./ClaudeQueryRunnerErrors.ts";
export {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  claudeProcessExitFailure,
  queryRunnerError,
} from "./ClaudeQueryRunnerErrors.ts";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_AGENT_SDK_QUERY_PROTOCOL = "claude-agent-sdk.query" as const;
const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];
// The SDK has no control-request deadline; the CLI waits up to 30 s per MCP server.
const CLAUDE_MCP_REGISTRATION_TIMEOUT = "90 seconds";
const CLAUDE_BOOT_TIMEOUT = "5 minutes";
// How often CLIs no agent scope holds have their process trees recorded, all from one table.
const CLAUDE_DESCENDANT_POLL = "1 second";

export {
  CLAUDE_CODE_PRESET_TOOLS,
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  claudeAgentSdkQueryToolsForSdk,
} from "./ClaudeSdkTools.ts";
export type {
  ClaudeAgentSdkQueryToolList,
  ClaudeAgentSdkQueryPresetTools,
  ClaudeAgentSdkQueryTools,
} from "./ClaudeSdkTools.ts";
export type ClaudeAgentSdkThreadIdentity =
  | {
      readonly sessionId: string;
      readonly resume?: never;
    }
  | {
      readonly sessionId?: never;
      readonly resume: string;
    };
export type ClaudeAgentSdkQueryOptions = Omit<
  ClaudeQueryOptions,
  "maxTurns" | "model" | "permissionMode" | "resume" | "sessionId" | "tools"
> & {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
} & ClaudeAgentSdkThreadIdentity;

export interface ClaudeAgentSdkQueryOpenInput {
  readonly interruptedResume?: true;
  readonly options: ClaudeAgentSdkQueryOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkQuerySession {
  readonly messages: Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;
  readonly offer: (
    message: SDKUserMessage,
    onQueued?: () => void,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setModel: (model: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly renameSession?: (title: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly applyFlagSettings: (
    settings: ClaudeFlagSettings,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setPermissionMode: (
    mode: PermissionMode,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  /** Replaces credentials over the existing SDK control channel without restarting work. */
  readonly setMcpServers?: (
    servers: NonNullable<ClaudeQueryOptions["mcpServers"]>,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly stopTask: (taskId: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAgentSdkQueryRunnerError>;
  readonly interrupt: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export type ClaudeQueryStreamExit = Exit.Exit<void, ClaudeAgentSdkQueryRunnerError>;

export interface ClaudeAgentSdkQueryRunnerShape {
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly open: (
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
  readonly forkSession: (
    input: ClaudeAgentSdkSessionForkInput,
  ) => Effect.Effect<
    ForkSessionResult & { readonly headMessageId?: string },
    ClaudeAgentSdkQueryRunnerError
  >;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAgentSdkSubagentLookupInput,
  ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
  /** The model a subagent's transcript says it ran on. Optional only for test fakes. */
  readonly subagentModel?: (
    input: ClaudeAgentSdkSubagentLookupInput,
  ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("goat/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner") {}

export interface ClaudeAgentSdkSessionForkInput {
  readonly sessionId: string;
  readonly options: ForkSessionOptions;
  readonly environment: NodeJS.ProcessEnv;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkSubagentLookupInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly dir: string | null;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);
export const isProviderAdapterRollbackThreadError = Schema.is(
  ProviderAdapter.ProviderAdapterRollbackThreadError,
);

function closeClaudeQuery(queryRuntime: ClaudeQuery) {
  return Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) => queryRunnerError(cause, "close"),
  });
}

// Iterate Query itself: the raw generator's return() queues behind a pending CLI read and deadlocks interruption.
export function claudeQueryMessages(queryRuntime: ClaudeQuery): AsyncIterable<SDKMessage, void> {
  return { [Symbol.asyncIterator]: () => queryRuntime };
}

export interface ClaudeAgentSdkLoggedQueryOptions {
  readonly model: ClaudeAgentSdkQueryOptions["model"];
  readonly tools: ClaudeAgentSdkQueryOptions["tools"];
  readonly permissionMode: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly sessionId?: string;
  readonly resume?: string;
  readonly resumeSessionAt?: ClaudeAgentSdkQueryOptions["resumeSessionAt"];
  readonly cwd?: ClaudeAgentSdkQueryOptions["cwd"];
  readonly allowedTools?: ClaudeAgentSdkQueryOptions["allowedTools"];
  readonly disallowedTools?: ClaudeAgentSdkQueryOptions["disallowedTools"];
  readonly settingKeys?: ReadonlyArray<string>;
  readonly effort?: ClaudeAgentSdkQueryOptions["effort"];
  readonly includePartialMessages?: true;
  readonly pathToClaudeCodeExecutable?: ClaudeAgentSdkQueryOptions["pathToClaudeCodeExecutable"];
  readonly hasExtraArgs?: true;
  readonly allowDangerouslySkipPermissions?: true;
  readonly hasCanUseTool?: true;
  readonly hasEnvironment?: true;
  readonly hasMcpServers?: true;
}

export type ClaudeAgentSdkProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.open";
        readonly options: ClaudeAgentSdkLoggedQueryOptions;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "prompt.offer";
        readonly message: SDKUserMessage;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.set_model";
        readonly model: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.apply_flag_settings";
        readonly settings: ClaudeFlagSettings;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.set_permission_mode";
        readonly mode: PermissionMode;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.stop_task";
        readonly taskId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.background_tasks";
        readonly toolUseId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.interrupt";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.close";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.fork";
        readonly sessionId: string;
        readonly options: ForkSessionOptions;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.forked";
        readonly sessionId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "subagent.lookup";
        readonly sessionId: string;
        readonly agentId: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "subagent.found";
        readonly toolUseId: string | null;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: SDKMessage;
    };

export type ClaudeAgentSdkProtocolLogger = (
  event: ClaudeAgentSdkProtocolLogEvent,
) => Effect.Effect<void>;

export function loggedClaudeQueryOptions(
  options: ClaudeAgentSdkQueryOptions,
): ClaudeAgentSdkLoggedQueryOptions {
  return {
    model: options.model,
    tools: options.tools,
    permissionMode: options.permissionMode,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.resumeSessionAt === undefined ? {} : { resumeSessionAt: options.resumeSessionAt }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(typeof options.settings === "object" && options.settings !== null
      ? { settingKeys: Object.keys(options.settings) }
      : {}),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.includePartialMessages === true ? { includePartialMessages: true } : {}),
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    ...(options.extraArgs === undefined ? {} : { hasExtraArgs: true }),
    ...(options.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.canUseTool === undefined ? {} : { hasCanUseTool: true }),
    ...(options.env === undefined ? {} : { hasEnvironment: true }),
    ...(options.mcpServers === undefined ? {} : { hasMcpServers: true }),
  };
}

function makeClaudeAgentSdkProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): ClaudeAgentSdkProtocolLogger | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: boundProviderEventForLogging(event),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

export const encodeClaudeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeHistoryFork = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ sessionId: Schema.String, headMessageId: Schema.optionalKey(Schema.String) }),
  ),
);

const claudeConfigDirOf = (
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) => path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(homeDirectory, ".claude"));

// The SDK reads CLAUDE_CONFIG_DIR from process.env. Isolate custom homes in a
// worker so concurrent providers keep the server's environment.
const runClaudeWorker = Effect.fn("runClaudeWorker")(function* (input: {
  readonly method: "forkSession" | "getSessionMessages";
  readonly sessionId: string;
  readonly options?: ForkSessionOptions;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const fromSource = import.meta.url.endsWith(".ts");
  // A single executable hosts the worker itself; it has no sibling script.
  const workerArguments = (yield* HostProcess.IsExecutable)
    ? ["__claude-history"]
    : [
        ...(fromSource ? ["--experimental-strip-types"] : []),
        yield* path.fromFileUrl(
          new URL(
            fromSource ? "../../claude-history-worker.ts" : "./claude-history-worker.mjs",
            import.meta.url,
          ),
        ),
      ];
  const executablePath = yield* HostProcess.ExecutablePath;
  const result = yield* spawnAndCollect(
    executablePath,
    ChildProcess.make(
      executablePath,
      [...workerArguments, input.method, input.sessionId, encodeClaudeJson(input.options ?? {})],
      {
        env: {
          ...input.environment,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ),
  ).pipe(Effect.timeout("30 seconds"));
  if (result.code !== 0) {
    return yield* new ClaudeAgentSdkQueryRunnerError({
      method: input.method,
      cause: result.stderr.trim() || `Claude history worker exited with code ${result.code}.`,
    });
  }
  return result.stdout;
});

const forkClaudeSessionInWorker = Effect.fn("forkClaudeSessionInWorker")(function* (
  input: ClaudeAgentSdkSessionForkInput,
) {
  return yield* runClaudeWorker({ ...input, method: "forkSession" }).pipe(
    Effect.flatMap(decodeClaudeHistoryFork),
  );
});

export const layerQueryRunner: Layer.Layer<
  ClaudeAgentSdkQueryRunner,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;
    const providerProcesses = yield* ProviderProcesses.ProviderProcesses;
    const platform = yield* HostProcess.Platform;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const descendants = yield* makeClaudeDescendantSampler({
      readTable: readClaudeProcessTable(yield* ProcessRunner.make()),
      interval: CLAUDE_DESCENDANT_POLL,
    });

    const hostEnvironment = yield* HostProcess.Environment;
    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: random
        .uuidV4()
        .pipe(Effect.mapError((cause) => queryRunnerError(cause, "allocateSessionId"))),
      open: Effect.fn("ClaudeAgentSdkQueryRunner.open")(
        function* (input: ClaudeAgentSdkQueryOpenInput) {
          const protocolLogger = makeClaudeAgentSdkProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
            protocolLogger === undefined ? Effect.void : protocolLogger(event);
          // A failed open shuts down its queue before retrying, so the old CLI cannot take the prompt.
          const promptQueue = yield* Queue.unbounded<SDKUserMessage>();
          const prompt = Stream.fromQueue(promptQueue).pipe(
            Stream.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
            ),
            Stream.toAsyncIterable,
          );
          // Send MCP credentials over stdin to keep them out of SDK argv and inherited command environments.
          const { mcpServers, ...sdkOptions } = input.options;
          const queryOptions = input.interruptedResume
            ? yield* interruptedResumeOptions(
                { ...sdkOptions, env: sdkOptions.env ?? hostEnvironment },
                (sessionId) =>
                  runClaudeWorker({
                    method: "getSessionMessages",
                    sessionId,
                    options: sdkOptions.cwd === undefined ? {} : { dir: sdkOptions.cwd },
                    environment: sdkOptions.env ?? hostEnvironment,
                  }).pipe(
                    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                    Effect.provideService(Path.Path, path),
                  ),
              ).pipe(Effect.mapError((cause) => queryRunnerError(cause, "getSessionMessages")))
            : sdkOptions;
          // The SDK can prepend a scope wrapper to native binaries; script entries run through node.
          const binaryPath = queryOptions.pathToClaudeCodeExecutable;
          const launch =
            binaryPath === undefined ||
            CLAUDE_SCRIPT_EXTENSIONS.some((ext) => binaryPath.endsWith(ext))
              ? undefined
              : yield* agentScope.wrap({
                  command: binaryPath,
                  args: [],
                  name: "claude",
                  threadId: input.threadId,
                  env: queryOptions.env,
                });
          const options =
            launch === undefined || launch.args.length === 0
              ? queryOptions
              : {
                  ...queryOptions,
                  pathToClaudeCodeExecutable: launch.command,
                  executableArgs: [...launch.args, ...(queryOptions.executableArgs ?? [])],
                };
          const unit = launch?.unit;
          const stopScope =
            unit === undefined ? undefined : () => void runFork(agentScope.stop(unit));
          let stderrTail = "";
          let stderrClosed: Promise<void> = Promise.resolve();
          let answered = false;
          let conversationMissing = false;
          const appendStderr = (text: string) => {
            if (!answered) stderrTail = (stderrTail + text).slice(-2_048);
          };
          let refreshDescendants: Effect.Effect<void> = Effect.void;
          const spawnProcess =
            options.spawnClaudeCodeProcess ??
            ((spawnOptions: ClaudeSpawnOptions) => {
              if (platform !== "win32") {
                let stderrDone = () => {};
                stderrClosed = new Promise((resolve) => (stderrDone = resolve));
                const child = spawnClaudeProcessGroup(
                  spawnOptions,
                  stopScope,
                  appendStderr,
                  stderrDone,
                  providerProcesses.register,
                );
                if (unit === undefined && child.pid !== undefined) {
                  const tracker = descendants.track(child.pid);
                  child.once("exit", () => runFork(tracker.stop));
                  refreshDescendants = tracker.refresh;
                }
                return child;
              }
              return spawnClaudeWindowsProcess(spawnOptions, (chunk) => options.stderr?.(chunk));
            });
          let spawnedProcess: ClaudeSpawnedProcess | undefined;
          let processExited = false;
          let processExit: Promise<void> | undefined;
          const spawnClaudeCodeProcess = (spawnOptions: ClaudeSpawnOptions) => {
            const child = spawnProcess(spawnOptions);
            spawnedProcess = child;
            watchClaudeProcess(child, (process) =>
              runFork(agentScope.watch({ process, threadId: input.threadId })),
            );
            processExited = child.exitCode !== null || child.signalCode != null;
            processExit = new Promise<void>((resolve) => {
              if (processExited) resolve();
              else
                child.once("exit", () => {
                  processExited = true;
                  resolve();
                });
            });
            return child;
          };
          const queryRuntime = yield* Effect.uninterruptibleMask((restore) =>
            Effect.try({
              try: () =>
                withoutClaudeCanUseToolShadowedWarning(() =>
                  query({ prompt, options: { ...options, spawnClaudeCodeProcess } }),
                ),
              catch: (cause) => queryRunnerError(cause, "query"),
            }).pipe(
              Effect.tap((queryRuntime) =>
                restore(
                  Effect.gen(function* () {
                    if (mcpServers !== undefined) {
                      const timedOut = (phase: ClaudeMcpRegistrationTimeoutError["phase"]) => () =>
                        Effect.logWarning("orchestration-v2.claude-mcp-registration-timeout", {
                          threadId: input.threadId,
                          providerSessionId: input.providerSessionId,
                          phase,
                        }).pipe(
                          Effect.andThen(
                            Effect.fail(
                              queryRunnerError(
                                new ClaudeMcpRegistrationTimeoutError({ phase }),
                                phase,
                              ),
                            ),
                          ),
                        );
                      // The SDK leaves query() boot unbounded, and it takes about a minute on a host
                      // with CPUs 12x oversubscribed, so it gets its own, longer deadline.
                      yield* Effect.promise(() =>
                        queryRuntime.initializationResult().catch(() => undefined),
                      ).pipe(
                        Effect.timeoutOrElse({
                          duration: CLAUDE_BOOT_TIMEOUT,
                          orElse: timedOut("initialize"),
                        }),
                      );
                      // Errors and mcp_status can echo headers; log only server names.
                      const failed = yield* Effect.tryPromise(() =>
                        queryRuntime.setMcpServers(mcpServers),
                      ).pipe(
                        Effect.map((result) => Object.keys(result.errors)),
                        Effect.orElseSucceed(() => Object.keys(mcpServers)),
                        Effect.timeoutOrElse({
                          duration: CLAUDE_MCP_REGISTRATION_TIMEOUT,
                          orElse: timedOut("setMcpServers"),
                        }),
                      );
                      if (failed.length > 0) {
                        yield* Effect.logWarning(
                          "orchestration-v2.claude-mcp-servers-unavailable",
                          {
                            threadId: input.threadId,
                            servers: failed,
                          },
                        );
                      }
                    }
                    yield* logProtocolEvent({
                      direction: "outgoing",
                      stage: "decoded",
                      payload: {
                        type: "query.open",
                        options: loggedClaudeQueryOptions(input.options),
                      },
                    });
                  }),
                ).pipe(
                  Effect.onError(() =>
                    Queue.shutdown(promptQueue).pipe(
                      // SDK disposal can return before process exit; await the owned child's exit before retrying.
                      Effect.andThen(
                        Effect.tryPromise({
                          try: async () => {
                            if (spawnedProcess !== undefined && !processExited) {
                              spawnedProcess.kill("SIGKILL");
                            }
                            await processExit;
                          },
                          catch: (cause) => queryRunnerError(cause, "close"),
                        }).pipe(Effect.timeout("10 seconds")),
                      ),
                      Effect.ensuring(
                        Effect.tryPromise({
                          try: () => queryRuntime[Symbol.asyncDispose](),
                          catch: (cause) => queryRunnerError(cause, "close"),
                        }).pipe(
                          // A disposal defect would hide the open's typed error under Effect 4.1.
                          Effect.ignore({ log: true }),
                        ),
                      ),
                      Effect.orDie,
                    ),
                  ),
                ),
              ),
            ),
          );

          return {
            messages: Stream.fromAsyncIterable(
              claudeQueryMessages(queryRuntime),
              (cause) => cause,
            ).pipe(
              Stream.catch((cause) =>
                Stream.fromEffect(
                  Effect.gen(function* () {
                    if (!answered)
                      yield* Effect.promise(() => stderrClosed).pipe(
                        Effect.timeoutOption("1 second"),
                      );
                    const refusedRoot = !answered && stderrTail.includes(CLAUDE_ROOT_REFUSAL);
                    return yield* queryRunnerError(
                      refusedRoot
                        ? new ClaudeCodeRootRefusalError({ cause })
                        : conversationMissing ||
                            (!answered && stderrTail.includes(CLAUDE_CONVERSATION_NOT_FOUND))
                          ? new ClaudeConversationNotFoundError({ cause })
                          : cause,
                      "fromAsyncIterable",
                    );
                  }),
                ),
              ),
              Stream.tap((message) =>
                Effect.sync(() => {
                  answered = true;
                  if (
                    message.type === "result" &&
                    message.subtype !== "success" &&
                    message.errors.some((error) => error.startsWith(CLAUDE_CONVERSATION_NOT_FOUND))
                  )
                    conversationMissing = true;
                  stderrTail = "";
                }),
              ),
              Stream.tap((message) =>
                logProtocolEvent({
                  direction: "incoming",
                  stage: "decoded",
                  payload: message,
                }),
              ),
            ),
            offer: (message, onQueued) =>
              Effect.uninterruptibleMask((restore) =>
                restore(Queue.offer(promptQueue, message)).pipe(
                  Effect.tap(() => Effect.sync(() => onQueued?.())),
                ),
              ).pipe(
                Effect.asVoid,
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "prompt.offer",
                      message,
                    },
                  }),
                ),
              ),
            setModel: (model) =>
              Effect.tryPromise({
                try: () => queryRuntime.setModel(model),
                catch: (cause) => queryRunnerError(cause, "setModel"),
              }).pipe(
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "query.set_model",
                      model,
                    },
                  }),
                ),
              ),
            renameSession: (title) => renameClaudeSession(queryRuntime, title),
            setMcpServers: (servers) =>
              Effect.tryPromise({
                try: async () => {
                  const result = await queryRuntime.setMcpServers(servers);
                  if (Object.keys(result.errors).length > 0)
                    throw new Error("MCP registration unavailable.");
                },
                catch: (cause) => queryRunnerError(cause, "setMcpServers"),
              }),
            applyFlagSettings: (settings) =>
              Effect.tryPromise({
                try: () => queryRuntime.applyFlagSettings(settings),
                catch: (cause) => queryRunnerError(cause, "applyFlagSettings"),
              }).pipe(
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "query.apply_flag_settings",
                      settings,
                    },
                  }),
                ),
              ),
            setPermissionMode: (mode) =>
              Effect.tryPromise({
                try: () => queryRuntime.setPermissionMode(mode),
                catch: (cause) => queryRunnerError(cause, "setPermissionMode"),
              }).pipe(
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "query.set_permission_mode",
                      mode,
                    },
                  }),
                ),
              ),
            stopTask: (taskId) =>
              Effect.tryPromise({
                try: () => queryRuntime.stopTask(taskId),
                catch: (cause) => queryRunnerError(cause, "stopTask"),
              }).pipe(
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: { type: "query.stop_task", taskId },
                  }),
                ),
              ),
            backgroundTasks: (toolUseId) =>
              Effect.tryPromise({
                try: () => queryRuntime.backgroundTasks(toolUseId),
                catch: (cause) => queryRunnerError(cause, "backgroundTasks"),
              }).pipe(
                Effect.tap(() =>
                  logProtocolEvent({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: { type: "query.background_tasks", toolUseId },
                  }),
                ),
              ),
            interrupt: Effect.tryPromise({
              try: () => queryRuntime.interrupt(),
              catch: (cause) => queryRunnerError(cause, "interrupt"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.interrupt",
                  },
                }),
              ),
            ),
            // A job started since the last sample is recorded before the CLI is told to exit.
            close: Effect.suspend(() => (processExited ? Effect.void : refreshDescendants)).pipe(
              Effect.andThen(Queue.shutdown(promptQueue)),
              Effect.andThen(closeClaudeQuery(queryRuntime)),
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.close",
                  },
                }),
              ),
            ),
          } satisfies ClaudeAgentSdkQuerySession;
        },
        // Fresh IDs may already have a metadata-only transcript; only resumed opens can reuse their ID.
        (effect, input) =>
          effect.pipe(
            Effect.retry({
              times: 1,
              while: (error) =>
                input.options.resume !== undefined &&
                isClaudeMcpRegistrationTimeoutError(error.cause),
            }),
          ),
      ),
      forkSession: Effect.fn("ClaudeAgentSdkQueryRunner.forkSession")(function* (
        input: ClaudeAgentSdkSessionForkInput,
      ) {
        const protocolLogger = makeClaudeAgentSdkProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "session.fork",
            sessionId: input.sessionId,
            options: input.options,
          },
        });
        const hostEnvironment = yield* HostProcess.Environment;
        const homeDirectory = yield* HostProcess.HomeDirectory;
        const usesHostConfig =
          claudeConfigDirOf(path, input.environment, homeDirectory) ===
          claudeConfigDirOf(path, hostEnvironment, homeDirectory);
        const fork: Effect.Effect<
          ForkSessionResult & { readonly headMessageId?: string },
          unknown
        > = usesHostConfig
          ? Effect.tryPromise(() => forkClaudeSession(input.sessionId, input.options))
          : forkClaudeSessionInWorker(input).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Path.Path, path),
            );
        const result = yield* fork.pipe(
          Effect.mapError((cause) => queryRunnerError(cause, "forkSession")),
        );
        yield* logProtocolEvent({
          direction: "incoming",
          stage: "decoded",
          payload: {
            type: "session.forked",
            sessionId: result.sessionId,
          },
        });
        // The SDK remaps copied UUIDs. Capture the inherited head before the
        // fork's first run appends messages.
        const headMessageId = usesHostConfig
          ? yield* Effect.tryPromise({
              try: () =>
                getSessionMessages(
                  result.sessionId,
                  input.options.dir === undefined ? {} : { dir: input.options.dir },
                ),
              catch: (cause) => queryRunnerError(cause, "getSessionMessages"),
            }).pipe(
              Effect.map((messages) => messages.at(-1)?.uuid),
              Effect.orElseSucceed(() => undefined),
            )
          : result.headMessageId;
        return headMessageId === undefined ? result : { ...result, headMessageId };
      }),
      subagentLaunchToolUseId: Effect.fn("ClaudeAgentSdkQueryRunner.subagentLaunchToolUseId")(
        function* (input: ClaudeAgentSdkSubagentLookupInput) {
          const protocolLogger = makeClaudeAgentSdkProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
            protocolLogger === undefined ? Effect.void : protocolLogger(event);
          yield* logProtocolEvent({
            direction: "outgoing",
            stage: "decoded",
            payload: {
              type: "subagent.lookup",
              sessionId: input.sessionId,
              agentId: input.agentId,
            },
          });
          const messages = yield* Effect.tryPromise({
            try: () =>
              getSubagentMessages(input.sessionId, input.agentId, {
                ...(input.dir === null ? {} : { dir: input.dir }),
                limit: 1,
              }),
            catch: (cause) => queryRunnerError(cause, "getSubagentMessages"),
          });
          const toolUseId = messages[0]?.parent_tool_use_id ?? null;
          yield* logProtocolEvent({
            direction: "incoming",
            stage: "decoded",
            payload: { type: "subagent.found", toolUseId },
          });
          return toolUseId;
        },
      ),
      subagentModel: Effect.fn("ClaudeAgentSdkQueryRunner.subagentModel")(function* (input) {
        const messages = yield* Effect.tryPromise({
          try: () =>
            getSubagentMessages(
              input.sessionId,
              input.agentId,
              input.dir === null ? {} : { dir: input.dir },
            ),
          catch: (cause) => queryRunnerError(cause, "getSubagentMessages"),
        });
        return lastClaudeTranscriptModel(messages);
      }),
      assertComplete: Effect.void,
    } satisfies Required<ClaudeAgentSdkQueryRunnerShape>);
  }),
);

export type ClaudeFlagSettings = Parameters<ClaudeQuery["applyFlagSettings"]>[0];
