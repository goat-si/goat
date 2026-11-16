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
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK's spawned CLI is a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import { spawnClaudeProcessGroup, spawnClaudeWindowsProcess } from "./ClaudeProcessSpawn.ts";
import { AgentScope, nodeChildAgentProcess } from "@goat/shared/AgentScope";
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

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_AGENT_SDK_QUERY_PROTOCOL = "claude-agent-sdk.query" as const;
const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];
// The SDK has no control-request deadline; the CLI waits up to 30 s per MCP server.
const CLAUDE_MCP_REGISTRATION_TIMEOUT = "90 seconds";
const CLAUDE_ROOT_REFUSAL =
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

export const CLAUDE_CODE_PRESET_TOOLS = {
  type: "preset",
  preset: "claude_code",
} satisfies NonNullable<ClaudeQueryOptions["tools"]>;
export type ClaudeAgentSdkQueryToolList = ReadonlyArray<string>;
export interface ClaudeAgentSdkQueryPresetTools {
  readonly type: "preset";
  readonly preset: "claude_code";
}
export type ClaudeAgentSdkQueryTools = ClaudeAgentSdkQueryToolList | ClaudeAgentSdkQueryPresetTools;
export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;
export function claudeAgentSdkQueryToolsForSdk(
  tools: ClaudeAgentSdkQueryTools,
): NonNullable<ClaudeQueryOptions["tools"]> {
  if (isClaudeAgentSdkQueryToolList(tools)) {
    return [...tools];
  }
  return { type: tools.type, preset: tools.preset };
}
function isClaudeAgentSdkQueryToolList(
  tools: ClaudeAgentSdkQueryTools,
): tools is ClaudeAgentSdkQueryToolList {
  return Array.isArray(tools);
}
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

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedError<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

class ClaudeCodeRootRefusalError extends Schema.TaggedError<ClaudeCodeRootRefusalError>()(
  "ClaudeCodeRootRefusalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude Code exited before it started: ${CLAUDE_ROOT_REFUSAL}`;
  }
}

class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {
  override get message(): string {
    return "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.";
  }
}

export class ClaudeBackgroundWorkBlocksQueryReplacementError extends Schema.TaggedError<ClaudeBackgroundWorkBlocksQueryReplacementError>()(
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  {},
) {
  override get message(): string {
    return "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.";
  }
}

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

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
const isClaudeMcpRegistrationTimeoutError = Schema.is(ClaudeMcpRegistrationTimeoutError);
export const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);
export const isProviderAdapterRollbackThreadError = Schema.is(
  ProviderAdapter.ProviderAdapterRollbackThreadError,
);

export function queryRunnerError(cause: unknown, method: string): ClaudeAgentSdkQueryRunnerError {
  return isClaudeAgentSdkQueryRunnerError(cause)
    ? cause
    : new ClaudeAgentSdkQueryRunnerError({ cause, method });
}

const CLAUDE_PROCESS_EXIT_ERROR_CLASSES: ReadonlySet<unknown> = new Set([
  "process_killed_by_signal",
  "process_exited_nonzero",
]);

// The SDK's exit Error appends Claude's stderr tail to `message`; `telemetryMessage` omits it.
export function claudeProcessExitFailure(
  cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
): { readonly message: string; readonly code: string } | undefined {
  const error = Cause.squash(cause);
  const sdkError = isClaudeAgentSdkQueryRunnerError(error) ? error.cause : error;
  if (typeof sdkError !== "object" || sdkError === null) return undefined;
  const { errorClass, telemetryMessage } = sdkError as Record<string, unknown>;
  return typeof errorClass === "string" &&
    CLAUDE_PROCESS_EXIT_ERROR_CLASSES.has(errorClass) &&
    typeof telemetryMessage === "string"
    ? { message: `${telemetryMessage}.`, code: errorClass }
    : undefined;
}

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
  readonly method: "forkSession";
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
    const platform = yield* HostProcess.Platform;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

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
          const { mcpServers, ...queryOptions } = input.options;
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
          const appendStderr = (text: string) => {
            if (!answered) stderrTail = (stderrTail + text).slice(-2_048);
          };
          const spawnProcess =
            options.spawnClaudeCodeProcess ??
            ((spawnOptions: ClaudeSpawnOptions) => {
              if (platform !== "win32") {
                let stderrDone = () => {};
                stderrClosed = new Promise((resolve) => (stderrDone = resolve));
                return spawnClaudeProcessGroup(spawnOptions, stopScope, appendStderr, stderrDone);
              }
              return spawnClaudeWindowsProcess(spawnOptions, (chunk) => options.stderr?.(chunk));
            });
          let spawnedProcess: ClaudeSpawnedProcess | undefined;
          let processExited = false;
          let processExit: Promise<void> | undefined;
          const spawnClaudeCodeProcess = (spawnOptions: ClaudeSpawnOptions) => {
            const child = spawnProcess(spawnOptions);
            spawnedProcess = child;
            const watched =
              child instanceof NodeChildProcess.ChildProcess
                ? nodeChildAgentProcess(child)
                : undefined;
            if (watched) runFork(agentScope.watch({ process: watched, threadId: input.threadId }));
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
                query({
                  prompt,
                  options: { ...options, spawnClaudeCodeProcess },
                }),
              catch: (cause) => queryRunnerError(cause, "query"),
            }).pipe(
              Effect.tap((queryRuntime) =>
                restore(
                  Effect.gen(function* () {
                    if (mcpServers !== undefined) {
                      // Errors and mcp_status can echo headers; log only server names.
                      const failed = yield* Effect.tryPromise(() =>
                        queryRuntime.setMcpServers(mcpServers),
                      ).pipe(
                        Effect.map((result) => Object.keys(result.errors)),
                        Effect.orElseSucceed(() => Object.keys(mcpServers)),
                        Effect.timeoutOrElse({
                          duration: CLAUDE_MCP_REGISTRATION_TIMEOUT,
                          orElse: () =>
                            Effect.logWarning("orchestration-v2.claude-mcp-registration-timeout", {
                              threadId: input.threadId,
                              providerSessionId: input.providerSessionId,
                            }).pipe(
                              Effect.andThen(
                                Effect.fail(
                                  queryRunnerError(
                                    new ClaudeMcpRegistrationTimeoutError(),
                                    "setMcpServers",
                                  ),
                                ),
                              ),
                            ),
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
                        }).pipe(Effect.orDie),
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
                      refusedRoot ? new ClaudeCodeRootRefusalError({ cause }) : cause,
                      "fromAsyncIterable",
                    );
                  }),
                ),
              ),
              Stream.tap(() =>
                Effect.sync(() => {
                  answered = true;
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
            close: Queue.shutdown(promptQueue).pipe(
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
      assertComplete: Effect.void,
    });
  }),
);

export type ClaudeFlagSettings = Parameters<ClaudeQuery["applyFlagSettings"]>[0];
