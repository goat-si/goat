import {
  ensureActiveAssistantSegment,
  closeActiveAssistantSegment,
  type AcpAssistantSegmentState,
} from "./assistantSegments.ts";
export {
  parseUnifiedCgroupPath,
  isSafeCgroupPath,
  parseCgroup2Mounts,
  parseCgroup2Mount,
} from "./cgroupPaths.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import { makeAcpRequestRunner } from "./AcpRequestDeadline.ts";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@goat/shared/shell";
import { AgentScope, AgentScopeThreadId, handleAgentProcess } from "@goat/shared/AgentScope";
import * as HostProcess from "@goat/shared/HostProcess";
import { signalProcessGroup } from "@goat/provider-core/server/processGroup";
import * as WindowsTaskkill from "@goat/provider-core/server/windowsTaskkill";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import { forkRuntimeScope } from "./runtimeScope.ts";
import { acpSpawnEnvironment } from "./sessionLaunchEnvironment.ts";
import {
  AcpProcessGroupTerminationError,
  makeLinuxCgroupController,
  resolveLinuxCgroupTargetCommand,
  signalLinuxCgroupRootTerm,
  terminateLinuxCgroupLease,
  withWallClock,
  wrapCommandForLinuxCgroup,
} from "./linuxCgroup.ts";
export {
  AcpProcessGroupTerminationError,
  makeLinuxCgroupController,
  resolveLinuxCgroupTargetCommand,
  signalLinuxCgroupRootTerm,
  sweepStaleLinuxCgroupSiblings,
  terminateLinuxCgroupLease,
  wrapCommandForLinuxCgroup,
  type SweepStaleLinuxCgroupSiblingsOptions,
} from "./linuxCgroup.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  isSessionLoadReplayIdle,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";

const MAX_SHOWN_TOOL_CALL_IDS = 256;

interface AcpToolCallTrackedState {
  readonly state: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent =
  | AcpParsedSessionEvent
  | AcpSessionEventStreamBarrier
  | {
      readonly _tag: "ConnectionTerminated";
      readonly error: EffectAcpErrors.AcpError;
    }
  | {
      // A session/load response that arrived after replay idle replaced the
      // provisional setup; its config/mode events were emitted just before.
      readonly _tag: "SessionSetupAdopted";
      readonly result: AcpSessionRuntimeStartResult;
    };

const defaultSessionLoadTimeout = Duration.seconds(90);
const defaultSessionLoadReplayIdleGap = Duration.seconds(2);
const defaultCancelTimeout = Duration.seconds(15);
const maxStartupMetadataUpdates = 32;
// Antigravity can emit an accepted 16 KiB Google authorization URL on stderr.
const maxStderrChunkLength = 32_768;

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
  readonly shell?: false;
}
export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly sessionEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly resumeMethod?: "load" | "resume";
  readonly requireSessionLoadResponse?: true;
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly sessionLoadReplayIdleReadiness?: boolean;
  readonly interruptPromptOnCancel?: boolean;
  readonly cancelMeta?: EffectAcpSchema.CancelNotification["_meta"];
  readonly initializeMeta?: EffectAcpSchema.InitializeRequest["_meta"];
  readonly ownDetachedProcessGroup?: boolean;
  readonly ownDescendantProcessGroups?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly windowsProcessTreeTerminator?: (
    pid: number,
  ) => Effect.Effect<void, AcpProcessGroupTerminationError>;
  readonly posixProcessTreeController?: AcpPosixProcessTreeController;
  readonly linuxCgroupController?: AcpLinuxCgroupController | null;
  readonly cancelBehavior?: "interrupt" | "wait-for-prompt";
  readonly cancelTimeout?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: NonNullable<EffectAcpSchema.InitializeRequest["clientInfo"]>;
  readonly authMethodId?: string;
  /** Authenticate before opening: Antigravity selects its credential source from the method. */
  readonly authenticateEagerly?: boolean;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** Sent on every session/new, load, resume and fork; omitting them clears an agent's stored roots. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Session `_meta`, chosen from the negotiated agent before each session setup or activation. */
  readonly sessionMeta?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => EffectAcpSchema.NewSessionRequest["_meta"] | undefined;
  readonly transformStdout?: EffectAcpClient.AcpClientOptions["transformStdout"];
  readonly transformSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /** Redact secrets before logging. Failure closes the runtime. */
  readonly onStderr?: (text: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Disable only for non-interactive discovery that must surface auth-required immediately. */
  readonly authenticateOnAuthRequired?: boolean;
  readonly onInitialized?: (
    result: EffectAcpSchema.InitializeResponse,
  ) => Effect.Effect<void, never>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  readonly onIncomingRequest?: EffectAcpClient.AcpClientOptions["onIncomingRequest"];
  readonly onTermination?: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly onOutgoingResponseFailure?: EffectAcpClient.AcpClientOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: EffectAcpClient.AcpClientOptions["onOutgoingResponse"];
  /** Unadvertised model IDs accepted by the config option; the agent validates them. */
  readonly customModels?: ReadonlyArray<string>;
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

const isAcpProcessGroupTerminationError = Schema.is(AcpProcessGroupTerminationError);

import {
  makePosixProcessTreeController,
  observePosixOwnershipLedger,
  observePosixOwnershipLedgerContinuously,
  terminatePosixOwnedProcessTree,
  type AcpOwnedPosixProcess,
  type AcpPosixOwnershipRoot,
  type AcpPosixProcessTreeController,
  type AcpLinuxCgroupController,
} from "./posixProcessTree.ts";
export {
  makePosixProcessTreeController,
  observePosixOwnershipLedger,
  capturePosixOwnershipLedger,
  terminatePosixOwnedProcessTree,
  posixProcessIsZombie,
  type AcpOwnedPosixProcess,
  type AcpPosixOwnershipRoot,
  type AcpPosixProcessIdentity,
  type AcpPosixProcessTreeController,
  type AcpLinuxCgroupLease,
  type AcpLinuxCgroupController,
} from "./posixProcessTree.ts";

const terminateWindowsProcessTreeWithTaskkill = Effect.fn("AcpSessionRuntime.terminateWindowsTree")(
  (pid: number) =>
    WindowsTaskkill.terminateWindowsTree(pid).pipe(
      Effect.mapError(
        (cause) =>
          new AcpProcessGroupTerminationError({
            pid,
            cause,
            detail: `Failed to run taskkill for ACP process tree ${pid}`,
          }),
      ),
    ),
);

export function selectAcpAgentAuthMethod(
  authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
  preferredMethodId?: string,
): EffectAcpSchema.AuthMethod | undefined {
  const preferred = preferredMethodId?.trim();
  if (preferred) {
    return authMethods?.find((method) => method.id === preferred);
  }
  return authMethods?.find((method) => method.type === undefined || method.type === "agent");
}

function isAcpAuthenticationRequired(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === -32000;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.ForkSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export interface AcpSessionActivationOptions {
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
}

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
    readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
    readonly handleMcpConnect: EffectAcpClient.AcpClient["Service"]["handleMcpConnect"];
    readonly handleMcpMessage: EffectAcpClient.AcpClient["Service"]["handleMcpMessage"];
    readonly handleMcpDisconnect: EffectAcpClient.AcpClient["Service"]["handleMcpDisconnect"];
    readonly handleMcpNotification: EffectAcpClient.AcpClient["Service"]["handleMcpNotification"];
    readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
    readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
    readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
    readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
    readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
    readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
    readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
    readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
    readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
    readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
    readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
    readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
    readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
    /** Reads capabilities without authentication, session creation, or MCP startup. */
    readonly initialize: () => Effect.Effect<
      EffectAcpSchema.InitializeResponse,
      EffectAcpErrors.AcpError
    >;
    readonly authenticate?: (methodId: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
    readonly drainEvents: Effect.Effect<void>;
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    readonly loadSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly resumeSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly forkSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly listSessions: (
      cursor?: string,
    ) => Effect.Effect<EffectAcpSchema.ListSessionsResponse, EffectAcpErrors.AcpError>;
    readonly closeSession: (
      sessionId?: string,
    ) => Effect.Effect<EffectAcpSchema.CloseSessionResponse, EffectAcpErrors.AcpError>;
    readonly deleteSession: (
      sessionId: string,
    ) => Effect.Effect<EffectAcpSchema.DeleteSessionResponse, EffectAcpErrors.AcpError>;
    readonly listProviders: Effect.Effect<
      EffectAcpSchema.ListProvidersResponse,
      EffectAcpErrors.AcpError
    >;
    readonly setProvider: (
      provider: EffectAcpSchema.SetProviderRequest,
    ) => Effect.Effect<EffectAcpSchema.SetProviderResponse, EffectAcpErrors.AcpError>;
    readonly disableProvider: (
      providerId: string,
    ) => Effect.Effect<EffectAcpSchema.DisableProviderResponse, EffectAcpErrors.AcpError>;
    readonly logout: Effect.Effect<EffectAcpSchema.LogoutResponse, EffectAcpErrors.AcpError>;
    /**
     * options.dispatched settles when cancel can target this prompt. options.released lets the
     * next prompt go out while this one's response is still held; it still resolves this call.
     */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
      options?: {
        readonly dispatched?: Deferred.Deferred<void>;
        readonly released?: Deferred.Deferred<void>;
      },
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly processContainment:
      | "cgroup-v2"
      | "process-ledger-reduced-guarantee"
      | "process-group"
      | "none";
    readonly terminateProcessGroup?: Effect.Effect<void, AcpProcessGroupTerminationError>;
    readonly setMode: (
      modeId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
    readonly setSessionModel: (
      modelId: string,
      meta?: EffectAcpSchema.SetSessionModelRequest["_meta"],
    ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
    /**
     * Writes a session configuration option. A select value the option does
     * not list is refused unless `allowUnlistedValue` is set, for agents that
     * take any value and judge it themselves (a custom model id the agent
     * does not list).
     */
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
      options?: {
        readonly allowUnlistedValue?: boolean;
        /** Sends the write even when the cached value already matches it. */
        readonly resendCurrentValue?: boolean;
      },
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }
>()("@goat/provider-acp/server/AcpSessionRuntime") {}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

type AcpInitializeState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<
        EffectAcpSchema.InitializeResponse,
        EffectAcpErrors.AcpError
      >;
    }
  | { readonly _tag: "Started"; readonly result: EffectAcpSchema.InitializeResponse };

interface AcpActivePrompt {
  readonly fiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly completed: Deferred.Deferred<void>;
  readonly queued: Deferred.Deferred<void>;
}

export const make = Effect.fn("AcpSessionRuntime.make")(function* (
  options: AcpSessionRuntimeOptions,
): Effect.fn.Return<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const runtimeScope = yield* forkRuntimeScope();
  const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
  const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallTrackedState>());
  const shownToolCallIds = new Set<string>();
  const assistantItemRuntimeId = yield* random.uuidV4().pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to generate an ACP assistant item runtime identifier.",
          cause,
        }),
    ),
  );
  const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
  const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
  const initializeStateRef = yield* Ref.make<AcpInitializeState>({ _tag: "NotStarted" });
  const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
  const startupMetadataRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionNotification>>(
    [],
  );
  const notificationSemaphore = yield* Semaphore.make(1);
  const terminationErrorRef = yield* Ref.make<Option.Option<EffectAcpErrors.AcpError>>(
    Option.none(),
  );
  const stoppingRef = yield* Ref.make(false);
  const stderrFailure = yield* Deferred.make<never, EffectAcpErrors.AcpError>();
  const stderrTailRef = yield* Ref.make("");
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const stderrDrained = yield* Deferred.make<void>();
  const runtimeClosed = yield* Deferred.make<void>();
  const promptSerializationSemaphore = yield* Semaphore.make(1);
  const sessionLoadSemaphore = yield* Semaphore.make(1);
  const promptDispatchSemaphore = yield* Semaphore.make(1);
  const activePromptRef = yield* Ref.make<Option.Option<AcpActivePrompt>>(Option.none());
  const assistantUpdatesOpenRef = yield* Ref.make(true);
  const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());
  // When replay idle makes a loaded session usable first, the agent's real
  // session/load response is still pending; it is adopted once it arrives.
  const lateSessionLoadRef = yield* Ref.make<
    Option.Option<{
      readonly payload: EffectAcpSchema.LoadSessionRequest;
      readonly provisional: EffectAcpSchema.LoadSessionResponse;
      readonly response: Fiber.Fiber<
        Option.Option<EffectAcpSchema.LoadSessionResponse>,
        EffectAcpErrors.AcpError
      >;
    }>
  >(Option.none());
  // Counts mode, config, and model writes sent to the agent and the mode and
  // config notifications it sent back. A late session/load response predates
  // all of them, even a write still pending or a notification that left the
  // mode state unchanged.
  const sessionChangeCountRef = yield* Ref.make(0);

  const ensureConnected = Effect.gen(function* () {
    const error = yield* Ref.get(terminationErrorRef);
    if (Option.isSome(error)) {
      return yield* error.value;
    }
    if (yield* Ref.get(stoppingRef)) {
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "The ACP session runtime is closed.",
        cause: undefined,
      });
    }
  });

  const enrichProcessExitWithStderr = (
    error: EffectAcpErrors.AcpError,
  ): Effect.Effect<EffectAcpErrors.AcpError> =>
    error._tag !== "AcpProcessExitedError" || (error.stderr?.trim().length ?? 0) > 0
      ? Effect.succeed(error)
      : Deferred.await(stderrDrained).pipe(
          Effect.timeout("250 millis"),
          Effect.ignore,
          Effect.andThen(Ref.get(stderrTailRef)),
          Effect.map((tail) => {
            const stderr = sanitizeAcpStderrExcerpt(tail, homeDirectory);
            return stderr.length === 0
              ? error
              : new EffectAcpErrors.AcpProcessExitedError({
                  ...(error.code !== undefined ? { code: error.code } : {}),
                  ...(error.signal !== undefined ? { signal: error.signal } : {}),
                  ...(error.pid !== undefined ? { pid: error.pid } : {}),
                  stderr,
                  ...(error.cause !== undefined ? { cause: error.cause } : {}),
                });
          }),
        );

  const recordTermination = Effect.fn("AcpSessionRuntime.recordTermination")(function* (
    error: EffectAcpErrors.AcpError,
  ) {
    if (yield* Ref.get(stoppingRef)) {
      return;
    }
    const enriched = yield* enrichProcessExitWithStderr(error);
    const firstTermination = yield* Ref.modify(terminationErrorRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some(enriched)] as const),
    );
    if (!firstTermination) {
      return;
    }
    yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
    yield* Queue.offer(eventQueue, { _tag: "ConnectionTerminated", error: enriched });
  });

  const logRequest = (event: AcpSessionRequestLogEvent) =>
    options.requestLogger ? options.requestLogger(event) : Effect.void;
  const runLoggedRequest = yield* makeAcpRequestRunner({
    scope: runtimeScope,
    onStderr: options.onStderr !== undefined,
    stderrFailure,
    terminated: (error) =>
      recordTermination(error).pipe(Effect.andThen(options.onTermination?.(error) ?? Effect.void)),
    enrich: enrichProcessExitWithStderr,
    log: logRequest,
  });
  const runLoggedSessionWrite = <A>(
    method: string,
    payload: unknown,
    effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) =>
    Ref.update(sessionChangeCountRef, (count) => count + 1).pipe(
      Effect.andThen(runLoggedRequest(method, payload, effect)),
    );
  const spawned = acpSpawnEnvironment(options.sessionEnvironment, options.spawn);
  const spawnCommand =
    options.spawn.shell === false
      ? { command: options.spawn.command, args: options.spawn.args, shell: false }
      : yield* resolveSpawnCommand(options.spawn.command, options.spawn.args, {
          ...(options.spawn.env ? { env: options.spawn.env } : {}),
          extendEnv: spawned.extendEnv,
        });
  const linuxCgroupLease =
    options.ownDescendantProcessGroups === true && options.processGroupPlatform === "linux"
      ? yield* Effect.sync(() => {
          try {
            if (options.linuxCgroupController === null) return undefined;
            return (options.linuxCgroupController ?? makeLinuxCgroupController()).create();
          } catch {
            return undefined;
          }
        })
      : undefined;
  // This is lifecycle containment for inherited provider work. It is not a
  // security boundary against a provider that can modify its delegated cgroup.
  if (linuxCgroupLease !== undefined) {
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.uninterruptible(terminateLinuxCgroupLease(linuxCgroupLease)).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    );
  }
  const containedTargetCommand =
    linuxCgroupLease === undefined || NodePath.isAbsolute(spawnCommand.command)
      ? spawnCommand.command
      : yield* Effect.gen(function* () {
          const resolved = resolveLinuxCgroupTargetCommand(
            spawnCommand.command,
            options.spawn.cwd ?? options.cwd,
            spawned.environment,
          );
          if (resolved !== undefined) return resolved;
          return yield* new EffectAcpErrors.AcpSpawnError({
            command: options.spawn.command,
            cause: new Error("Contained ACP command was not found on PATH"),
          });
        });
  const agentScope = yield* AgentScope;
  const scopedLaunch =
    linuxCgroupLease !== undefined || spawnCommand.shell
      ? undefined
      : yield* agentScope.wrap({
          command: spawnCommand.command,
          args: spawnCommand.args,
          name: "acp",
          threadId: yield* AgentScopeThreadId,
          env: spawned.environment,
        });
  const scopedSpawnCommand =
    scopedLaunch === undefined ? spawnCommand : { ...scopedLaunch, shell: false };
  // Finalizers run in reverse order: reap detached work after terminating the agent.
  const scopeUnit = scopedLaunch?.unit;
  const stopScope =
    scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
  yield* Scope.addFinalizer(runtimeScope, stopScope);
  const containedSpawnCommand =
    linuxCgroupLease === undefined
      ? scopedSpawnCommand
      : {
          ...wrapCommandForLinuxCgroup(linuxCgroupLease, containedTargetCommand, spawnCommand.args),
          shell: false,
        };
  const spawnEnvironment =
    linuxCgroupLease === undefined
      ? options.spawn.env
      : {
          ...options.spawn.env,
          ELECTRON_RUN_AS_NODE: "1",
          GOAT_ACP_CGROUP_WRAPPER: "1",
        };
  const child = yield* spawner
    .spawn(
      ChildProcess.make(containedSpawnCommand.command, containedSpawnCommand.args, {
        ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
        ...(spawnEnvironment ? { env: spawnEnvironment } : {}),
        extendEnv: spawned.extendEnv,
        // Windows taskkill owns tree cleanup while the shim keeps attached stdio.
        ...(options.ownDetachedProcessGroup === undefined
          ? {}
          : { detached: options.ownDetachedProcessGroup && hostPlatform !== "win32" }),
        shell: containedSpawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpSpawnError({
            command: options.spawn.command,
            cause,
          }),
      ),
    );

  yield* agentScope.watch({
    process: handleAgentProcess(child),
    threadId: yield* AgentScopeThreadId,
  });

  // Detached children can keep stdout open, delaying protocol termination.
  if (scopeUnit !== undefined) {
    yield* child.exitCode.pipe(
      Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
      Effect.forkIn(runtimeScope),
    );
  }

  const posixOwnershipLedger = new Map<string, AcpOwnedPosixProcess>();
  const posixOwnershipFrontier = new Map<number, AcpOwnedPosixProcess>();
  const posixOwnershipChildQueues = new Map<number, Array<number>>();
  const posixOwnershipRoot: AcpPosixOwnershipRoot = { value: undefined };
  const posixController =
    options.ownDescendantProcessGroups === true
      ? yield* Effect.try({
          try: () => {
            if (options.posixProcessTreeController !== undefined) {
              return options.posixProcessTreeController;
            }
            if (options.processGroupPlatform === undefined) {
              throw new AcpProcessGroupTerminationError({
                detail: "POSIX ACP descendant ownership requires a supported host platform",
              });
            }
            return makePosixProcessTreeController(options.processGroupPlatform);
          },
          catch: (cause) =>
            new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
        })
      : undefined;
  if (posixController !== undefined) {
    const observeOwnership = () =>
      observePosixOwnershipLedger({
        childQueues: posixOwnershipChildQueues,
        controller: posixController,
        frontier: posixOwnershipFrontier,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      });
    yield* Effect.try({
      try: observeOwnership,
      catch: (cause) =>
        new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
    });
    // Cgroup teardown needs only the root identity captured above.
    if (linuxCgroupLease === undefined) {
      yield* observePosixOwnershipLedgerContinuously({
        childQueues: posixOwnershipChildQueues,
        controller: posixController,
        frontier: posixOwnershipFrontier,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      }).pipe(Effect.forkIn(runtimeScope));
    }
  }

  const signalOwnedProcessGroup = (signal: NodeJS.Signals) =>
    Effect.try({
      try: () => {
        signalProcessGroup(Number(child.pid), signal);
        return true;
      },
      catch: (cause) =>
        new AcpProcessGroupTerminationError({
          cause,
          detail: `Failed to signal ACP process group ${child.pid} with ${signal}`,
        }),
    }).pipe(
      Effect.catch((error) => {
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        return cause?.code === "ESRCH" ? Effect.succeed(false) : Effect.fail(error);
      }),
    );
  const terminateWindowsProcessTree =
    options.windowsProcessTreeTerminator ??
    ((pid: number) =>
      terminateWindowsProcessTreeWithTaskkill(pid).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ));
  const terminatePosixProcessTree = Effect.fn("AcpSessionRuntime.terminatePosixProcessTree")(
    function* (grace: Duration.Input, platformOverride?: NodeJS.Platform) {
      const platform = platformOverride ?? options.processGroupPlatform;
      if (platform === undefined || platform === "win32") {
        return yield* new AcpProcessGroupTerminationError({
          detail: "POSIX ACP descendant ownership requires a supported host platform",
        });
      }
      const controller = yield* Effect.try({
        try: () => posixController ?? makePosixProcessTreeController(platform),
        catch: (cause) =>
          isAcpProcessGroupTerminationError(cause)
            ? cause
            : new AcpProcessGroupTerminationError({
                cause,
                detail: `Failed to initialize ACP descendant ownership on ${platform}`,
              }),
      });
      yield* terminatePosixOwnedProcessTree({
        controller,
        grace,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      });
    },
  );
  const terminateOwnedProcessGroupImpl = Effect.gen(function* () {
    if (options.ownDetachedProcessGroup !== true) return;
    if (options.processGroupPlatform === undefined) {
      return yield* new AcpProcessGroupTerminationError({
        detail: "Detached ACP process-group ownership requires a host platform",
      });
    }
    if (options.processGroupPlatform === "win32") {
      return yield* terminateWindowsProcessTree(Number(child.pid));
    }
    if (linuxCgroupLease !== undefined) {
      if (posixController !== undefined) {
        yield* Effect.sync(() =>
          signalLinuxCgroupRootTerm({
            controller: posixController,
            lease: linuxCgroupLease,
            root: posixOwnershipRoot,
          }),
        );
      }
      const grace = options.processGroupTerminationGrace ?? "1 second";
      if (grace !== 0) yield* Effect.sleep(grace);
      return yield* terminateLinuxCgroupLease(linuxCgroupLease);
    }
    if (options.ownDescendantProcessGroups === true) {
      return yield* terminatePosixProcessTree(options.processGroupTerminationGrace ?? "1 second");
    }
    const groupExisted = yield* signalOwnedProcessGroup("SIGTERM");
    if (!groupExisted) return;
    const grace = options.processGroupTerminationGrace ?? "1 second";
    if (grace !== 0) {
      yield* Effect.sleep(grace);
    }
    yield* signalOwnedProcessGroup("SIGKILL");
  }).pipe(withWallClock);
  const terminateProcessGroup = yield* Effect.cached(
    Effect.uninterruptible(terminateOwnedProcessGroupImpl),
  );
  if (options.ownDetachedProcessGroup === true) {
    const forceTerminateOwnedProcessGroup =
      hostPlatform === "win32"
        ? terminateWindowsProcessTreeWithTaskkill(Number(child.pid)).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
        : linuxCgroupLease !== undefined
          ? terminateLinuxCgroupLease(linuxCgroupLease)
          : options.ownDescendantProcessGroups === true
            ? terminatePosixProcessTree(0, hostPlatform)
            : signalOwnedProcessGroup("SIGKILL").pipe(Effect.asVoid);
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.uninterruptible(forceTerminateOwnedProcessGroup).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    );
  }
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTailRef, (current) => appendAcpStderrTail(current, chunk)).pipe(
        Effect.andThen(
          options.onStderr ? options.onStderr(chunk.slice(-maxStderrChunkLength)) : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Deferred.fail(stderrFailure, error);
            yield* recordTermination(error);
            yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
          }),
        ),
      ),
    ),
    Effect.ensuring(Deferred.succeed(stderrDrained, undefined)),
    Effect.ignore,
    Effect.forkIn(runtimeScope),
  );

  const acpContext = yield* Layer.build(
    EffectAcpClient.layerChildProcess(child, {
      ...(options.transformStdout ? { transformStdout: options.transformStdout } : {}),
      ...(options.transformSessionUpdate
        ? { transformSessionUpdate: options.transformSessionUpdate }
        : {}),
      ...(options.protocolLogging?.logIncoming !== undefined
        ? { logIncoming: options.protocolLogging.logIncoming }
        : {}),
      ...(options.protocolLogging?.logOutgoing !== undefined
        ? { logOutgoing: options.protocolLogging.logOutgoing }
        : {}),
      ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
      onTermination: (error) =>
        recordTermination(error).pipe(
          Effect.andThen(options.onTermination?.(error) ?? Effect.void),
          Effect.ensuring(
            Scope.close(runtimeScope, Exit.fail(error)).pipe(Effect.forkDetach, Effect.asVoid),
          ),
        ),
      ...(options.onOutgoingResponseFailure
        ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
        : {}),
      ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
    }),
  ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

  const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

  const configOptionUpdates = yield* Ref.make(0);
  const processSessionUpdate = (notification: EffectAcpSchema.SessionNotification) =>
    (notification.update.sessionUpdate === "config_option_update"
      ? Ref.update(configOptionUpdates, (count) => count + 1).pipe(
          Effect.andThen(Ref.update(sessionChangeCountRef, (count) => count + 1)),
        )
      : notification.update.sessionUpdate === "current_mode_update"
        ? Ref.update(sessionChangeCountRef, (count) => count + 1)
        : Effect.void
    ).pipe(
      Effect.andThen(
        handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          configOptionsRef,
          toolCallsRef,
          shownToolCallIds,
          assistantSegmentRef,
          assistantItemRuntimeId,
          params: notification,
        }),
      ),
    );

  yield* acp.handleSessionUpdate((notification) =>
    notificationSemaphore.withPermit(
      Effect.gen(function* () {
        if (Option.isSome(yield* Ref.get(terminationErrorRef))) {
          return;
        }
        const gate = yield* Ref.get(sessionLoadGateRef);
        // A different session can still have an in-flight prompt while this
        // load replays history, so quarantine only the loading session.
        const loadingThisSession =
          Option.isSome(gate) &&
          gate.value.active &&
          notification.sessionId === gate.value.sessionId;
        if (
          loadingThisSession &&
          sessionUpdateCountsAsLoadReplayActivity(
            notification,
            gate.value.sessionId,
            gate.value.lastActivityAtMillis !== undefined,
          )
        ) {
          const lastActivityAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              ...gate.value,
              lastActivityAtMillis,
            }),
          );
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        const startState = yield* Ref.get(startStateRef);
        if (startState._tag === "Starting") {
          if (isStartupMetadataUpdate(notification)) {
            yield* Ref.update(startupMetadataRef, (current) =>
              [
                ...current.filter(
                  (previous) =>
                    previous.sessionId !== notification.sessionId ||
                    previous.update.sessionUpdate !== notification.update.sessionUpdate,
                ),
                notification,
              ].slice(-maxStartupMetadataUpdates),
            );
          }
          return;
        }
        if (loadingThisSession) {
          if (notification.update.sessionUpdate === "config_option_update") {
            const candidateConfigOptions = notification.update.configOptions;
            yield* Ref.update(sessionLoadGateRef, (current) =>
              Option.isSome(current)
                ? Option.some({ ...current.value, candidateConfigOptions })
                : current,
            );
          }
          return;
        }
        // One runtime projects one root ACP session. Child-session updates need
        // explicit lineage routing and must never be flattened into this stream.
        if (
          startState._tag !== "Started" ||
          notification.sessionId !== startState.result.sessionId
        ) {
          return;
        }
        if (
          !(yield* Ref.get(assistantUpdatesOpenRef)) &&
          (notification.update.sessionUpdate === "agent_message_chunk" ||
            notification.update.sessionUpdate === "agent_thought_chunk")
        ) {
          return;
        }
        yield* processSessionUpdate(notification);
      }),
    ),
  );
  yield* Scope.addFinalizer(
    runtimeScope,
    Ref.set(stoppingRef, true).pipe(Effect.andThen(Deferred.succeed(runtimeClosed, undefined))),
  );
  const initializeClientCapabilities = {
    fs: {
      readTextFile: false,
      writeTextFile: false,
      ...options.clientCapabilities?.fs,
    },
    terminal: options.clientCapabilities?.terminal ?? false,
    // ACP v1 agents send session notices only to clients that advertise them; v2 needs no capability.
    session: { ...options.clientCapabilities?.session, notices: {} },
    ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
    ...(options.clientCapabilities?.elicitation
      ? { elicitation: options.clientCapabilities.elicitation }
      : {}),
    ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
  } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

  const getStartedState = Effect.gen(function* () {
    yield* ensureConnected;
    const state = yield* Ref.get(startStateRef);
    if (state._tag === "Started") {
      return state.result;
    }
    return yield* new EffectAcpErrors.AcpTransportError({
      detail: "ACP session runtime has not been started",
      cause: "ACP session runtime has not been started",
    });
  });

  const validateConfigOptionValue = Effect.fn("AcpSessionRuntime.validateConfigOptionValue")(
    function* (
      configId: string,
      value: string | boolean,
      allowUnlistedValue: boolean,
    ): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
      const configOptions = yield* Ref.get(configOptionsRef);
      const configOption = findSessionConfigOption(configOptions, configId);
      if (!configOption) {
        return;
      }
      if (configOption.type === "boolean") {
        if (typeof value === "boolean") {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
          data: {
            configId: configOption.id,
            expectedType: "boolean",
            receivedValue: value,
          },
        });
      }
      if (typeof value !== "string") {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
          data: {
            configId: configOption.id,
            expectedType: "string",
            receivedValue: value,
          },
        });
      }
      const allowedValues = collectSessionConfigOptionValues(configOption);
      if (allowUnlistedValue || allowedValues.includes(value)) {
        return;
      }
      if (
        configOption === findModelConfigOption(configOptions) &&
        options.customModels?.includes(value)
      ) {
        return;
      }
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
        data: {
          configId: configOption.id,
          allowedValues,
          receivedValue: value,
        },
      });
    },
  );

  const updateConfigOptions = Effect.fn("AcpSessionRuntime.updateConfigOptions")(function* (
    response:
      | EffectAcpSchema.SetSessionConfigOptionResponse
      | EffectAcpSchema.ForkSessionResponse
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse,
  ) {
    const configOptions = sessionConfigOptionsFromSetup(response);
    yield* Ref.set(configOptionsRef, configOptions);
    yield* Queue.offer(eventQueue, {
      _tag: "ConfigOptionsUpdated",
      configOptions,
      rawPayload: response,
    });
  });

  const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
    Ref.update(modeStateRef, (current) =>
      current ? { ...current, currentModeId: modeId } : current,
    );

  const adoptSession = Effect.fn("AcpSessionRuntime.adoptSession")(function* (
    sessionId: string,
    sessionSetupResult:
      | EffectAcpSchema.ForkSessionResponse
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse,
  ): Effect.fn.Return<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError> {
    const current = yield* getStartedState;
    const meta = sessionSetupResult._meta;
    const syntheticReplayIdle = isSessionLoadReplayIdle(meta);
    const extractedModelConfigId = extractModelConfigId(sessionSetupResult);
    const nextModelConfigId =
      extractedModelConfigId ?? (syntheticReplayIdle ? current.modelConfigId : undefined);
    const nextModeState = parseSessionModeState(sessionSetupResult);
    if (nextModeState !== undefined) {
      yield* Ref.set(modeStateRef, nextModeState);
    } else if (!syntheticReplayIdle) {
      yield* Ref.set(modeStateRef, undefined);
    }
    // Synthetic replay-idle load responses only carry initialize model/mode
    // meta; preserve live configOptions so setConfigOption still validates.
    if (
      sessionSetupResult.configOptions !== undefined &&
      sessionSetupResult.configOptions !== null
    ) {
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
    } else if (!syntheticReplayIdle) {
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));
    }
    const nextState = {
      sessionId,
      initializeResult: current.initializeResult,
      sessionSetupResult,
      modelConfigId: nextModelConfigId,
    } satisfies AcpStartedState;
    yield* Ref.set(toolCallsRef, new Map());
    yield* Ref.set(assistantSegmentRef, { nextSegmentIndex: 0 });
    yield* Ref.set(startStateRef, { _tag: "Started", result: nextState });
    return nextState;
  });

  const cancelLateSessionLoad = Ref.getAndSet(lateSessionLoadRef, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (late) => Fiber.interrupt(late.response),
      }),
    ),
    Effect.asVoid,
  );

  // Adopts the agent's real session/load response after a replay-idle start.
  // Anything that changed the session or its configuration in between is newer
  // than this response, so the response is dropped instead of applied.
  const followLateSessionLoad = Effect.fn("AcpSessionRuntime.followLateSessionLoad")(function* (
    started: AcpStartedState,
    // Notifications counted after this baseline are newer than the response.
    provisionalChangeCount?: number,
  ) {
    const late = yield* Ref.get(lateSessionLoadRef);
    if (Option.isNone(late) || late.value.provisional !== started.sessionSetupResult) {
      return;
    }
    const { payload, response: lateFiber } = late.value;
    const provisionalConfigOptions = yield* Ref.get(configOptionsRef);
    const provisionalModeState = yield* Ref.get(modeStateRef);
    const baselineChangeCount = provisionalChangeCount ?? (yield* Ref.get(sessionChangeCountRef));
    const adoptLateResponse = Effect.fn("AcpSessionRuntime.adoptLateSessionLoad")(function* (
      response: EffectAcpSchema.LoadSessionResponse,
    ) {
      const current = yield* Ref.get(lateSessionLoadRef);
      const startState = yield* Ref.get(startStateRef);
      if (
        Option.isNone(current) ||
        current.value.response !== lateFiber ||
        startState._tag !== "Started" ||
        startState.result !== started ||
        (yield* Ref.get(stoppingRef)) ||
        (yield* Ref.get(configOptionsRef)) !== provisionalConfigOptions ||
        (yield* Ref.get(modeStateRef)) !== provisionalModeState ||
        (yield* Ref.get(sessionChangeCountRef)) !== baselineChangeCount
      ) {
        return;
      }
      yield* Ref.set(lateSessionLoadRef, Option.none());
      const result = {
        ...started,
        sessionSetupResult: response,
        modelConfigId: extractModelConfigId(response) ?? started.modelConfigId,
      };
      yield* Ref.set(startStateRef, { _tag: "Started", result });
      const modeState = parseSessionModeState(response);
      if (modeState !== undefined) {
        yield* Ref.set(modeStateRef, modeState);
      }
      if (response.configOptions != null) {
        yield* processSessionUpdate({
          sessionId: started.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: response.configOptions },
        });
      } else if (modeState !== undefined) {
        yield* processSessionUpdate({
          sessionId: started.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: modeState.currentModeId },
        });
      }
      yield* Queue.offer(eventQueue, { _tag: "SessionSetupAdopted", result });
    });
    yield* Fiber.join(lateFiber).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                operation: "call-rpc",
                method: "session/load",
                detail: "session/load timed out after replay idle",
                cause: undefined,
              }),
            ),
          onSome: (response) =>
            notificationSemaphore.withPermit(adoptLateResponse(response)).pipe(
              Effect.andThen(
                logRequest({
                  method: "session/load",
                  payload,
                  status: "succeeded",
                  result: response,
                }),
              ),
            ),
        }),
      ),
      // Supersession and shutdown interrupt the request; only a real failure
      // or timeout is worth a failed log.
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : logRequest({ method: "session/load", payload, status: "failed", cause }),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );
  });

  const runLoadSession = (
    loadPayload: EffectAcpSchema.LoadSessionRequest,
    initializeResult: EffectAcpSchema.InitializeResponse,
  ): Effect.Effect<EffectAcpSchema.LoadSessionResponse, EffectAcpErrors.AcpError> =>
    sessionLoadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const sessionLoadTimeout = Duration.fromInputUnsafe(
          options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
        );
        const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
          options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
        );

        yield* Ref.set(
          sessionLoadGateRef,
          Option.some({
            active: true,
            sessionId: loadPayload.sessionId,
            lastActivityAtMillis: undefined,
            idleGap: sessionLoadReplayIdleGap,
            initializeResult,
          }),
        );

        yield* cancelLateSessionLoad;
        return yield* Effect.gen(function* () {
          yield* logRequest({
            method: "session/load",
            payload: loadPayload,
            status: "started",
          });

          // Forked so a replay-idle win leaves the request running; the timeout
          // still bounds it and the runtime scope cancels it on shutdown.
          const responseFiber = yield* acp.agent
            .loadSession(loadPayload)
            .pipe(Effect.timeoutOption(sessionLoadTimeout), Effect.forkIn(runtimeScope));
          const awaitResponse = Fiber.join(responseFiber).pipe(
            Effect.map(Option.map((response) => ({ response, provisional: false }))),
          );
          const loadOrReplayIdle =
            options.sessionLoadReplayIdleReadiness === true && !options.requireSessionLoadResponse
              ? Effect.gen(function* () {
                  const idleFiber = yield* waitForSessionLoadReplayIdle({
                    gateRef: sessionLoadGateRef,
                  }).pipe(Effect.forkIn(runtimeScope));
                  return yield* Effect.raceFirst(
                    awaitResponse,
                    Fiber.join(idleFiber).pipe(
                      Effect.map((response) => Option.some({ response, provisional: true })),
                    ),
                  ).pipe(Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)));
                })
              : awaitResponse;
          const loaded = yield* loadOrReplayIdle.pipe(
            Effect.timeoutOption(sessionLoadTimeout),
            Effect.flatMap((result) =>
              Effect.fromOption(
                Option.flatten(result),
                () =>
                  new EffectAcpErrors.AcpTransportError({
                    operation: "call-rpc",
                    method: "session/load",
                    detail:
                      options.sessionLoadReplayIdleReadiness === true &&
                      !options.requireSessionLoadResponse
                        ? "session/load timed out waiting for RPC response or replay idle gap"
                        : "session/load timed out waiting for RPC response",
                    cause: undefined,
                  }),
              ),
            ),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) && exit.value.provisional
                ? Effect.void
                : Fiber.interrupt(responseFiber).pipe(Effect.ignore),
            ),
            Effect.tap(({ response }) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "succeeded",
                result: response,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "failed",
                cause,
              }),
            ),
          );

          const gate = yield* Ref.get(sessionLoadGateRef);
          const candidateConfigOptions = Option.isSome(gate)
            ? gate.value.candidateConfigOptions
            : undefined;
          const response =
            loaded.response.configOptions == null && candidateConfigOptions !== undefined
              ? { ...loaded.response, configOptions: candidateConfigOptions }
              : loaded.response;
          if (loaded.provisional) {
            yield* Ref.set(
              lateSessionLoadRef,
              Option.some({ payload: loadPayload, provisional: response, response: responseFiber }),
            );
          }
          return response;
        }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
      }),
    );

  const setConfigOption = (
    configId: string,
    value: string | boolean,
    options?: {
      readonly allowUnlistedValue?: boolean;
      readonly resendCurrentValue?: boolean;
    },
  ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
    validateConfigOptionValue(configId, value, options?.allowUnlistedValue === true).pipe(
      Effect.andThen(getStartedState),
      Effect.flatMap((started) =>
        Ref.get(configOptionsRef).pipe(
          Effect.flatMap((configOptions) => {
            const existing = findSessionConfigOption(configOptions, configId);
            if (
              existing &&
              options?.resendCurrentValue !== true &&
              configOptionCurrentValueMatches(existing, value)
            ) {
              return Effect.succeed({
                configOptions,
              } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
            }
            const requestPayload =
              typeof value === "boolean"
                ? ({
                    sessionId: started.sessionId,
                    configId,
                    type: "boolean",
                    value,
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                : ({
                    sessionId: started.sessionId,
                    configId,
                    value: String(value),
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
            // An update the agent pushed while the write was in flight is
            // newer than its result: Kiro 2.32 answers a `model` write
            // without `model`, then advertises it, and that update can be
            // handled before this fiber resumes. The result then stays out.
            return Ref.get(configOptionUpdates).pipe(
              Effect.flatMap((updatesBefore) =>
                runLoggedSessionWrite(
                  "session/set_config_option",
                  requestPayload,
                  acp.agent.setSessionConfigOption(requestPayload),
                ).pipe(
                  Effect.tap((response) =>
                    Ref.get(configOptionUpdates).pipe(
                      Effect.flatMap((updatesNow) =>
                        updatesNow === updatesBefore ? updateConfigOptions(response) : Effect.void,
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );

  const initializeOnce = Effect.gen(function* () {
    const initializePayload = {
      protocolVersion: 2,
      clientCapabilities: initializeClientCapabilities,
      clientInfo: options.clientInfo,
      ...(options.initializeMeta === undefined ? {} : { _meta: options.initializeMeta }),
    } satisfies EffectAcpSchema.InitializeRequest;

    const initializeResult = yield* runLoggedRequest(
      "initialize",
      initializePayload,
      acp.agent.initialize(initializePayload),
    );
    yield* options.onInitialized?.(initializeResult) ?? Effect.void;
    return initializeResult;
  });

  const initialize = Effect.gen(function* () {
    yield* ensureConnected;
    const deferred = yield* Deferred.make<
      EffectAcpSchema.InitializeResponse,
      EffectAcpErrors.AcpError
    >();
    const effect = yield* Ref.modify(initializeStateRef, (state) => {
      switch (state._tag) {
        case "Started":
          return [Effect.succeed(state.result), state] as const;
        case "Starting":
          return [Deferred.await(state.deferred), state] as const;
        case "NotStarted":
          return [
            initializeOnce.pipe(
              Effect.tap((result) =>
                Ref.set(initializeStateRef, { _tag: "Started", result }).pipe(
                  Effect.andThen(Deferred.succeed(deferred, result)),
                ),
              ),
              Effect.onError((cause) =>
                Deferred.failCause(deferred, cause).pipe(
                  Effect.andThen(Ref.set(initializeStateRef, { _tag: "NotStarted" })),
                ),
              ),
            ),
            { _tag: "Starting", deferred } satisfies AcpInitializeState,
          ] as const;
      }
    });
    return yield* effect;
  });

  const sessionMcpServers = (
    initializeResult: EffectAcpSchema.InitializeResponse,
    activationOptions?: AcpSessionActivationOptions,
  ): ReadonlyArray<EffectAcpSchema.McpServer> => {
    const httpServers =
      activationOptions === undefined ? options.httpMcpServers : activationOptions.httpMcpServers;
    if (
      initializeResult.agentCapabilities?.mcpCapabilities?.http === true &&
      httpServers !== undefined
    ) {
      return httpServers;
    }
    const acpServers = activationOptions?.acpMcpServers ?? options.acpMcpServers ?? [];
    if (
      initializeResult.agentCapabilities?.mcpCapabilities?.acp === true &&
      acpServers.length > 0
    ) {
      return acpServers;
    }
    return activationOptions?.mcpServers ?? options.mcpServers ?? [];
  };

  const sessionSetupFields = (initializeResult: EffectAcpSchema.InitializeResponse) => {
    const meta = options.sessionMeta?.(initializeResult);
    return {
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      ...(meta == null ? {} : { _meta: meta }),
    };
  };

  const startOnce = Effect.gen(function* () {
    const initializeResult = yield* initialize;

    const authenticateAfterRequired = Effect.fn("AcpSessionRuntime.authenticateAfterRequired")(
      function* (
        authRequiredError: EffectAcpErrors.AcpError,
      ): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
        const configuredAuthMethodId = options.authMethodId?.trim();
        const authMethod = selectAcpAgentAuthMethod(
          initializeResult.authMethods,
          configuredAuthMethodId,
        );
        if (
          configuredAuthMethodId &&
          initializeResult.authMethods !== undefined &&
          authMethod === undefined
        ) {
          return yield* new EffectAcpErrors.AcpTransportError({
            detail: `ACP agent did not advertise configured authentication method "${configuredAuthMethodId}"`,
            cause: { configuredAuthMethodId, authMethods: initializeResult.authMethods },
          });
        }
        if (
          authMethod !== undefined &&
          authMethod.type !== undefined &&
          authMethod.type !== "agent"
        ) {
          return yield* new EffectAcpErrors.AcpTransportError({
            detail: `ACP authentication method "${authMethod.id}" requires ${authMethod.type} authentication, which cannot run inside a headless provider session`,
            cause: authMethod,
          });
        }

        const authMethodId = authMethod?.id ?? configuredAuthMethodId;
        if (!authMethodId) {
          return yield* authRequiredError;
        }

        const authenticatePayload = {
          methodId: authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;
        yield* runLoggedRequest(
          "authenticate",
          authenticatePayload,
          acp.agent.authenticate(authenticatePayload),
        );
      },
    );

    const setupSession = Effect.gen(function* () {
      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      const additionalDirectories = sessionSetupFields(initializeResult);
      if (options.resumeSessionId) {
        sessionId = options.resumeSessionId;
        if (
          initializeResult.agentCapabilities?.loadSession === true &&
          options.resumeMethod !== "resume"
        ) {
          const loadPayload = {
            sessionId,
            cwd: options.cwd,
            ...additionalDirectories,
            mcpServers: sessionMcpServers(initializeResult),
          } satisfies EffectAcpSchema.LoadSessionRequest;
          sessionSetupResult = yield* runLoadSession(loadPayload, initializeResult);
        } else if (initializeResult.agentCapabilities?.sessionCapabilities?.resume != null) {
          const resumePayload = {
            sessionId,
            cwd: options.cwd,
            ...additionalDirectories,
            mcpServers: sessionMcpServers(initializeResult),
          } satisfies EffectAcpSchema.ResumeSessionRequest;
          sessionSetupResult = yield* runLoggedRequest(
            "session/resume",
            resumePayload,
            acp.agent.resumeSession(resumePayload),
          );
        } else {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise session/load or session/resume support",
          });
        }
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: sessionMcpServers(initializeResult),
          ...additionalDirectories,
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      return { sessionId, sessionSetupResult };
    });

    if (options.authenticateEagerly === true) {
      // The configured method is authoritative here: Antigravity accepts
      // methods (API key, Vertex) it does not list in `initialize`.
      const authenticatePayload = {
        methodId: options.authMethodId ?? "",
      } satisfies EffectAcpSchema.AuthenticateRequest;
      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );
    }
    const { sessionId, sessionSetupResult } = yield* setupSession.pipe(
      Effect.catchIf(
        (error) =>
          !(!isAcpAuthenticationRequired(error) || options.authenticateOnAuthRequired === false),
        (error) => authenticateAfterRequired(error).pipe(Effect.andThen(setupSession)),
      ),
    );

    yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
    yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

    const nextState = {
      sessionId,
      initializeResult,
      sessionSetupResult,
      modelConfigId: extractModelConfigId(sessionSetupResult),
    } satisfies AcpStartedState;
    return nextState;
  });

  const start = Effect.gen(function* () {
    yield* ensureConnected;
    const deferred = yield* Deferred.make<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>();
    const effect = yield* Ref.modify(startStateRef, (state) => {
      switch (state._tag) {
        case "Started":
          return [Effect.succeed(state.result), state] as const;
        case "Starting":
          return [Deferred.await(state.deferred), state] as const;
        case "NotStarted":
          return [
            startOnce.pipe(
              Effect.tap((result) =>
                notificationSemaphore.withPermit(
                  Effect.gen(function* () {
                    const error = yield* Ref.get(terminationErrorRef);
                    if (Option.isSome(error)) {
                      return yield* error.value;
                    }
                    yield* Ref.set(startStateRef, { _tag: "Started", result });
                    const changeCountBeforeMetadata = yield* Ref.get(sessionChangeCountRef);
                    const metadata = yield* Ref.getAndSet(startupMetadataRef, []);
                    for (const notification of metadata) {
                      if (notification.sessionId === result.sessionId) {
                        yield* processSessionUpdate(notification);
                      }
                    }
                    yield* followLateSessionLoad(result, changeCountBeforeMetadata);
                    yield* Deferred.succeed(deferred, result);
                  }),
                ),
              ),
              Effect.onError((cause) =>
                Deferred.failCause(deferred, cause).pipe(
                  Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  Effect.andThen(Ref.set(startupMetadataRef, [])),
                ),
              ),
            ),
            { _tag: "Starting", deferred } satisfies AcpStartState,
          ] as const;
      }
    });
    return yield* effect;
  });

  const drainEvents = Effect.gen(function* () {
    if (yield* Ref.get(stoppingRef)) {
      return;
    }
    const acknowledge = yield* Deferred.make<void>();
    yield* notificationSemaphore.withPermit(
      Effect.gen(function* () {
        if (Option.isNone(yield* Ref.get(activePromptRef))) {
          yield* Ref.set(assistantUpdatesOpenRef, false);
          yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
        }
        yield* Queue.offer(eventQueue, { _tag: "EventStreamBarrier", acknowledge });
      }),
    );
    yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(runtimeClosed));
  });

  const retireRuntime = Effect.fn("AcpSessionRuntime.retireRuntime")(function* (
    error: EffectAcpErrors.AcpError,
  ) {
    yield* recordTermination(error);
    yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
  });

  const joinPrompt = (
    fiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
  ) =>
    Fiber.join(fiber).pipe(
      Effect.catchCauseIf(
        (cause) => options.cancelBehavior !== "wait-for-prompt" && Cause.hasInterruptsOnly(cause),
        (_cause) =>
          Effect.succeed({ stopReason: "cancelled" } satisfies EffectAcpSchema.PromptResponse),
      ),
    );

  const cancel = Effect.gen(function* () {
    const started = yield* getStartedState;
    const activePrompt = yield* Ref.get(activePromptRef);
    const cancelPayload = {
      sessionId: started.sessionId,
      ...(options.cancelMeta === undefined ? {} : { _meta: options.cancelMeta }),
    } satisfies EffectAcpSchema.CancelNotification;
    const promptQueued = Option.isSome(activePrompt)
      ? Effect.raceFirst(
          Deferred.await(activePrompt.value.queued),
          Fiber.await(activePrompt.value.fiber).pipe(Effect.asVoid),
        ).pipe(Effect.timeoutOption(options.cancelTimeout ?? defaultCancelTimeout))
      : Effect.void;
    if (options.cancelBehavior !== "wait-for-prompt") {
      if (options.interruptPromptOnCancel === false) {
        yield* promptQueued;
        return yield* acp.agent.cancel(cancelPayload);
      }
      if (Option.isSome(activePrompt)) {
        yield* Fiber.interrupt(activePrompt.value.fiber).pipe(Effect.ignore);
      }
      // Write cancel before a replacement prompt can reach the agent.
      yield* acp.agent.cancel(cancelPayload).pipe(Effect.ignore);
      return;
    }

    yield* promptQueued;
    yield* acp.agent.cancel(cancelPayload);
    if (Option.isNone(activePrompt)) {
      return;
    }
    const completed = yield* Effect.gen(function* () {
      const result = yield* Fiber.await(activePrompt.value.fiber);
      yield* Deferred.await(activePrompt.value.completed);
      if (Option.isNone(yield* Ref.get(terminationErrorRef))) {
        yield* drainEvents;
      }
      return result;
    }).pipe(Effect.timeoutOption(options.cancelTimeout ?? defaultCancelTimeout));
    if (Option.isNone(completed)) {
      const error = new EffectAcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/cancel",
        detail: "The ACP agent did not finish cancellation. Its process was stopped.",
        cause: undefined,
      });
      yield* retireRuntime(error);
      return yield* error;
    }
    if (Exit.isFailure(completed.value)) {
      return yield* Effect.failCause(completed.value.cause);
    }
  });

  return {
    processContainment:
      linuxCgroupLease !== undefined
        ? "cgroup-v2"
        : options.ownDescendantProcessGroups === true
          ? "process-ledger-reduced-guarantee"
          : options.ownDetachedProcessGroup === true
            ? "process-group"
            : "none",
    handleRequestPermission: acp.handleRequestPermission,
    handleElicitation: acp.handleElicitation,
    handleMcpConnect: acp.handleMcpConnect,
    handleMcpMessage: acp.handleMcpMessage,
    handleMcpDisconnect: acp.handleMcpDisconnect,
    handleMcpNotification: acp.handleMcpNotification,
    handleReadTextFile: acp.handleReadTextFile,
    handleWriteTextFile: acp.handleWriteTextFile,
    handleCreateTerminal: acp.handleCreateTerminal,
    handleTerminalOutput: acp.handleTerminalOutput,
    handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
    handleTerminalKill: acp.handleTerminalKill,
    handleTerminalRelease: acp.handleTerminalRelease,
    handleSessionUpdate: acp.handleSessionUpdate,
    handleElicitationComplete: acp.handleElicitationComplete,
    handleUnknownExtRequest: acp.handleUnknownExtRequest,
    handleUnknownExtNotification: acp.handleUnknownExtNotification,
    handleExtRequest: acp.handleExtRequest,
    handleExtNotification: acp.handleExtNotification,
    initialize: () => initialize,
    authenticate: (methodId) =>
      initialize.pipe(
        Effect.andThen(
          runLoggedRequest("authenticate", { methodId }, acp.agent.authenticate({ methodId })),
        ),
        Effect.asVoid,
      ),
    start: () => start,
    getEvents: () => Stream.fromQueue(eventQueue),
    drainEvents,
    getModeState: Ref.get(modeStateRef),
    getConfigOptions: Ref.get(configOptionsRef),
    loadSession: (sessionId, activationOptions) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
          } satisfies EffectAcpSchema.LoadSessionRequest;
          return runLoadSession(requestPayload, started.initializeResult);
        }),
        Effect.flatMap((response) => adoptSession(sessionId, response)),
        Effect.tap((started) => followLateSessionLoad(started)),
      ),
    resumeSession: (sessionId, activationOptions) =>
      start.pipe(
        Effect.tap(() => cancelLateSessionLoad),
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
          } satisfies EffectAcpSchema.ResumeSessionRequest;
          return runLoggedRequest(
            "session/resume",
            requestPayload,
            acp.agent.resumeSession(requestPayload),
          );
        }),
        Effect.flatMap((response) => adoptSession(sessionId, response)),
      ),
    forkSession: (sessionId, activationOptions) =>
      start.pipe(
        Effect.tap(() => cancelLateSessionLoad),
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
          } satisfies EffectAcpSchema.ForkSessionRequest;
          return runLoggedRequest(
            "session/fork",
            requestPayload,
            acp.agent.forkSession(requestPayload),
          );
        }),
        Effect.flatMap((response) => adoptSession(response.sessionId, response)),
      ),
    listSessions: (cursor) => {
      const requestPayload = {
        cwd: options.cwd,
        ...(cursor === undefined ? {} : { cursor }),
      } satisfies EffectAcpSchema.ListSessionsRequest;
      return initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.sessionCapabilities?.list != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise session/list support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("session/list", requestPayload, acp.agent.listSessions(requestPayload)),
        ),
      );
    },
    closeSession: (sessionId) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId: sessionId ?? started.sessionId,
          } satisfies EffectAcpSchema.CloseSessionRequest;
          return runLoggedRequest(
            "session/close",
            requestPayload,
            acp.agent.closeSession(requestPayload),
          );
        }),
      ),
    deleteSession: (sessionId) =>
      initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.sessionCapabilities?.delete != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise session/delete support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("session/delete", { sessionId }, acp.agent.deleteSession({ sessionId })),
        ),
      ),
    listProviders: initialize.pipe(
      Effect.filterOrFail(
        (initialized) => initialized.agentCapabilities?.providers != null,
        () =>
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise provider configuration support",
          }),
      ),
      Effect.andThen(runLoggedRequest("providers/list", {}, acp.agent.listProviders({}))),
    ),
    setProvider: (provider) =>
      initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.providers != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise provider configuration support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest(
            "providers/set",
            {
              ...provider,
              ...(provider.headers === undefined
                ? {}
                : {
                    headers: Object.fromEntries(
                      Object.keys(provider.headers).map((name) => [name, "[redacted]"]),
                    ),
                  }),
            },
            acp.agent.setProvider(provider),
          ),
        ),
      ),
    disableProvider: (providerId) => {
      const request = { providerId } satisfies EffectAcpSchema.DisableProviderRequest;
      return initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.providers != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise provider configuration support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("providers/disable", request, acp.agent.disableProvider(request)),
        ),
      );
    },
    logout: initialize.pipe(
      Effect.filterOrFail(
        (initialized) => initialized.agentCapabilities?.auth?.logout != null,
        () =>
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise logout support",
          }),
      ),
      Effect.andThen(runLoggedRequest("logout", {}, acp.agent.logout({}))),
    ),
    prompt: (payload, promptOptions?) =>
      promptSerializationSemaphore
        .withPermit(
          Effect.acquireUseRelease(
            promptDispatchSemaphore.withPermit(
              Effect.gen(function* () {
                const started = yield* getStartedState;
                yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
                yield* Ref.set(assistantUpdatesOpenRef, true);
                const requestPayload = {
                  sessionId: started.sessionId,
                  ...payload,
                } satisfies EffectAcpSchema.PromptRequest;
                const completed = yield* Deferred.make<void>();
                const queued = yield* Deferred.make<void>();
                const fiber = yield* runLoggedRequest(
                  "session/prompt",
                  requestPayload,
                  acp.agent
                    .prompt(requestPayload)
                    .pipe(Effect.provideService(EffectAcpProtocol.AcpOutgoingQueued, queued)),
                ).pipe(Effect.forkIn(runtimeScope));
                const active = { fiber, completed, queued } satisfies AcpActivePrompt;
                yield* Ref.set(activePromptRef, Option.some(active));
                if (promptOptions?.dispatched) {
                  yield* Deferred.succeed(promptOptions.dispatched, undefined);
                }
                return active;
              }).pipe(notificationSemaphore.withPermit),
            ),
            (activePrompt) => {
              const settled = joinPrompt(activePrompt.fiber).pipe(
                Effect.tap(() =>
                  closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef }),
                ),
                Effect.map((response) => ({ _tag: "Settled" as const, response })),
              );
              return promptOptions?.released === undefined
                ? settled
                : Effect.raceFirst(
                    settled,
                    Deferred.await(promptOptions.released).pipe(
                      Effect.as({ _tag: "Released" as const, fiber: activePrompt.fiber }),
                    ),
                  );
            },
            (activePrompt, result) =>
              Effect.gen(function* () {
                if (Exit.isSuccess(result) && result.value._tag === "Released") {
                  yield* Ref.set(activePromptRef, Option.none());
                  yield* Deferred.succeed(activePrompt.completed, undefined);
                  return;
                }
                if (
                  options.cancelBehavior === "wait-for-prompt" &&
                  Exit.isFailure(result) &&
                  Cause.hasInterrupts(result.cause)
                ) {
                  yield* retireRuntime(
                    new EffectAcpErrors.AcpTransportError({
                      method: "session/prompt",
                      detail: "The ACP prompt stopped before the agent confirmed completion.",
                      cause: undefined,
                    }),
                  );
                }
                yield* Fiber.interrupt(activePrompt.fiber).pipe(Effect.ignore);
                yield* Ref.set(activePromptRef, Option.none());
                yield* Deferred.succeed(activePrompt.completed, undefined);
              }),
          ),
        )
        .pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Settled"
              ? Effect.succeed(outcome.response)
              : joinPrompt(outcome.fiber),
          ),
        ),
    cancel:
      options.cancelBehavior === "wait-for-prompt" || options.interruptPromptOnCancel === false
        ? promptDispatchSemaphore.withPermit(cancel)
        : cancel,
    ...(options.ownDetachedProcessGroup === true ? { terminateProcessGroup } : {}),
    // A session's mode is its `category: "mode"` config option. ACP v1 agents
    // that only advertise `modes` (gemini-cli) take `session/set_mode`
    // instead, which ACP v2 removed.
    setMode: Effect.fn("AcpSessionRuntime.setMode")(function* (modeId) {
      const modeState = yield* Ref.get(modeStateRef);
      if (modeState?.currentModeId === modeId) {
        return {} satisfies EffectAcpSchema.SetSessionModeResponse;
      }
      const modeConfigOption = (yield* Ref.get(configOptionsRef))?.find(
        (option) => option.category === "mode" && option.type === "select",
      );
      if (modeConfigOption === undefined && modeState !== undefined) {
        const started = yield* getStartedState;
        const payload = { sessionId: started.sessionId, modeId };
        yield* runLoggedSessionWrite(
          "session/set_mode",
          payload,
          acp.agent.setSessionMode(payload),
        );
        yield* updateCurrentModeId(modeId);
        return {} satisfies EffectAcpSchema.SetSessionModeResponse;
      }
      const response = yield* setConfigOption(modeConfigOption?.id ?? "mode", modeId);
      const reported = parseSessionModeState({ configOptions: response.configOptions });
      if (reported === undefined) {
        yield* updateCurrentModeId(modeId);
      } else {
        yield* updateCurrentModeId(reported.currentModeId);
      }
      return {} satisfies EffectAcpSchema.SetSessionModeResponse;
    }),
    setSessionModel: (modelId, meta) =>
      getStartedState.pipe(
        Effect.flatMap((started) => {
          const payload = {
            sessionId: started.sessionId,
            modelId,
            ...(meta === undefined ? {} : { _meta: meta }),
          };
          return runLoggedSessionWrite(
            "session/set_model",
            payload,
            acp.agent.setSessionModel(payload),
          );
        }),
      ),
    setConfigOption,
    setModel: (model) =>
      getStartedState.pipe(
        Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
        Effect.asVoid,
      ),

    request: (method, payload) =>
      ensureConnected.pipe(
        Effect.andThen(runLoggedRequest(method, payload, acp.raw.request(method, payload))),
      ),
    notify: (method, payload) =>
      ensureConnected.pipe(Effect.andThen(acp.raw.notify(method, payload))),
  } satisfies AcpSessionRuntime["Service"];
});

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> => Layer.effect(AcpSessionRuntime, make(options));

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

function isStartupMetadataUpdate(notification: EffectAcpSchema.SessionNotification): boolean {
  switch (notification.update.sessionUpdate) {
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update":
      return true;
    default:
      return false;
  }
}

const handleSessionUpdate =
  /* Provider events include streaming deltas; avoid a span for each update. */
  Effect.fnUntraced(function* ({
    queue,
    modeStateRef,
    configOptionsRef,
    toolCallsRef,
    shownToolCallIds,
    assistantSegmentRef,
    assistantItemRuntimeId,
    params,
  }: {
    readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
    readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
    readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
    readonly shownToolCallIds: Set<string>;
    readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
    readonly assistantItemRuntimeId: string;
    readonly params: EffectAcpSchema.SessionNotification;
  }): Effect.fn.Return<void> {
    if (params.update.sessionUpdate === "config_option_update") {
      const configOptions = params.update.configOptions;
      yield* Ref.set(configOptionsRef, configOptions);
      yield* Ref.update(
        modeStateRef,
        (current) => parseSessionModeState({ configOptions }) ?? current,
      );
    }
    const parsed = parseSessionUpdateEvent(params);
    const modeId = parsed.modeId;
    if (modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, modeId),
      );
      // A mode-only update would otherwise leave the mode option showing the old mode.
      const configOptions = yield* Ref.get(configOptionsRef);
      const isStaleMode = (option: (typeof configOptions)[number]) =>
        option.category === "mode" && option.type === "select" && option.currentValue !== modeId;
      if (configOptions.some(isStaleMode)) {
        yield* Ref.set(
          configOptionsRef,
          configOptions.map((option) =>
            option.category === "mode" && option.type === "select"
              ? { ...option, currentValue: modeId }
              : option,
          ),
        );
      }
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const { merged, decision, active } = yield* Ref.modify(toolCallsRef, (current) => {
          const tracked = current.get(event.toolCall.toolCallId);
          const previous = tracked?.state;
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const decision = decideToolCallUpdateEmission({
            previous,
            next: nextToolCall,
            lastEmittedDetailLength: tracked?.lastEmittedDetailLength,
            skippedSinceEmit: tracked?.skippedSinceEmit ?? 0,
          });
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, {
              state: nextToolCall,
              lastEmittedDetailLength: decision.emit
                ? toolCallProgressLength(nextToolCall)
                : tracked?.lastEmittedDetailLength,
              skippedSinceEmit: decision.skippedSinceEmit,
            });
          }
          return [{ merged: nextToolCall, decision, active: tracked !== undefined }, next] as const;
        });
        if (!decision.emit) {
          continue;
        }
        if (!shownToolCallIds.has(merged.toolCallId)) {
          shownToolCallIds.add(merged.toolCallId);
          if (shownToolCallIds.size > MAX_SHOWN_TOOL_CALL_IDS) {
            shownToolCallIds.delete(shownToolCallIds.values().next().value!);
          }
          if (!active) yield* closeActiveAssistantSegment({ queue, assistantSegmentRef });
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}
