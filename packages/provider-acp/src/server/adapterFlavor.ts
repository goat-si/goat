// The contract a provider flavor implements to run on the shared ACP adapter.
import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ThreadId,
} from "@goat/contracts";
import type { SelfInvocation } from "@goat/shared/nodeRuntime";
import type * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type { AcpSessionModeState, AcpToolCallState } from "./runtimeModel.ts";
import type { AcpPermissionDisposition } from "./clientPolicy.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { BackgroundWork } from "@goat/provider-core/server/notification";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";

export interface AcpAdapterV2RuntimeInput {
  readonly cwd: string;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly resumeSessionId?: string;
  readonly interruptPromptOnCancel?: boolean;
  readonly clientCapabilities: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: AcpSessionRuntime.AcpSessionRuntimeOptions["clientInfo"];
  readonly requestLogger?: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["requestLogger"]>;
  readonly protocolLogging: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]
  >;
  readonly onTermination: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]>;
  readonly onOutgoingResponseFailure?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponse"];
  readonly onIncomingRequest?: AcpSessionRuntime.AcpSessionRuntimeOptions["onIncomingRequest"];
}

export type AcpAdapterV2NativeLogging = Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "requestLogger" | "protocolLogging"
>;

export interface AcpAdapterV2UserInputRequest {
  readonly nativeItemId: string;
  readonly nativeRequestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

export interface AcpAdapterV2ExtensionContext {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly reportProviderRetry: (input: {
    readonly sessionId: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }) => Effect.Effect<void>;
  readonly finishSubagent: (notice: {
    readonly sessionId: string;
    readonly childSessionId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly result: string | null;
  }) => Effect.Effect<void>;
  readonly applyBackgroundTaskMutation: (mutation: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly output?: string;
    readonly report?: BackgroundWork;
  }) => Effect.Effect<void>;
  /**
   * For agents that hold `session/prompt` past their foreground work on ACP v1. An idle settles
   * the run only after a `running` report during it, so an earlier prompt's idle cannot.
   */
  readonly reportForegroundWork: (notice: {
    readonly sessionId: string;
    readonly state: "running" | "idle";
  }) => Effect.Effect<void>;
  readonly requestUserInput: (
    input: AcpAdapterV2UserInputRequest,
    requestContext: EffectAcpProtocol.AcpRequestContext,
  ) => Effect.Effect<
    {
      readonly acknowledgeNativeResponse: Effect.Effect<void, EffectAcpErrors.AcpError>;
      readonly answers: ProviderUserInputAnswers | null;
    },
    EffectAcpErrors.AcpError
  >;
  readonly captureProposedPlan: (input: { readonly planMarkdown: string }) => Effect.Effect<void>;
  readonly lastProposedPlanMarkdown: Effect.Effect<string | undefined>;
}

/**
 * Raised when an agent does not accept the session's model selection: the
 * session's model option does not offer it, or the agent answers the write
 * with invalid params. `makeProviderFailure` shows its message to the user;
 * the agent's reply stays on `cause`.
 */
export interface AcpAdapterV2Flavor {
  readonly buildPrompt?: (input: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
    readonly agentVersion: string | undefined;
    /** The session's model after selection, with its display name when the agent lists it. */
    readonly currentModel: { readonly id: string; readonly name: string | undefined } | undefined;
  }) => Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>, EffectAcpErrors.AcpError>;
  readonly promptFailure?: (cause: unknown) => OrchestrationV2ProviderFailure;
  /**
   * Runs before `session/prompt`. The returned check sees a prompt the agent ended
   * without an error or cancel, and reports a failure its stop reason hid. A reported
   * failure restarts the runtime before the next turn.
   */
  readonly watchPromptOutcome?: (
    sessionId: string,
  ) => Effect.Effect<
    (
      result: EffectAcpSchema.PromptResponse,
    ) => Effect.Effect<OrchestrationV2ProviderFailure | undefined>
  >;
  readonly requiresSignIn?: (cause: unknown) => boolean;
  /**
   * Runs before attachment paths, GOAT instructions and native slash-command detection,
   * so a rewrite can turn the user's text into a native command.
   */
  readonly rewriteUserText?: (
    text: string,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner>;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly clientCapabilitiesMeta?: NonNullable<
    EffectAcpSchema.InitializeRequest["clientCapabilities"]
  >["_meta"];
  readonly normalizeSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  readonly onAvailableCommandsUpdate?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly onSessionConfigurationUpdate?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
    modelState: EffectAcpSchema.SessionModelState | null | undefined,
  ) => Effect.Effect<void>;
  readonly onUrlElicitation?: (input: {
    readonly elicitationId: string;
    readonly url: string;
    readonly message: string;
  }) => Effect.Effect<boolean>;
  readonly extractElicitationForm?: (request: EffectAcpSchema.CreateElicitationRequest) =>
    | {
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        readonly respond: (
          answers: ProviderUserInputAnswers,
        ) => EffectAcpSchema.CreateElicitationResponse;
      }
    | undefined;
  readonly withRuntimeStartup?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly makeRuntime: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly customModels?: ReadonlyArray<string>;
  /** The agent may run another model than session/new reports, so the model is always written. */
  readonly alwaysSetModel?: boolean;
  /** Values the client shows for options a new session's selection leaves unset. */
  readonly unsetOptionDefaults?: Effect.Effect<NonNullable<ModelSelection["options"]>>;
  readonly resolveModelId?: (selection: ModelSelection) => string | undefined;
  readonly getModelContextWindow?: (
    selection: ModelSelection,
    session: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => number | undefined;
  readonly applyModelSelection?: (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
  readonly ownedModelOptionIds?: ReadonlyArray<string>;
  readonly sessionModeForPolicy?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) => string | undefined;
  readonly clientFileSystem?: {
    readonly readTextFile: (
      request: EffectAcpSchema.ReadTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError>;
    readonly writeTextFile?: (
      request: EffectAcpSchema.WriteTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError>;
  };
  readonly extractPermissionQuestion?: (request: EffectAcpSchema.RequestPermissionRequest) =>
    | {
        readonly question: OrchestrationV2UserInputQuestion;
        readonly respond: (
          answers: ProviderUserInputAnswers,
        ) => EffectAcpSchema.RequestPermissionResponse | undefined;
      }
    | undefined;
  /** Grok Auto asks only about classifier refusals; GOAT policy must not auto-approve them. */
  readonly permissionDisposition?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => AcpPermissionDisposition;
  readonly approvalOptions?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => ReadonlyArray<ProviderApprovalOption>;
  /** Prefer resume over load when both exist; Antigravity's load replays history slowly. */
  readonly preferResumeSession?: boolean;
  readonly onSessionEvent?: (
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) => Effect.Effect<void>;
  readonly subagentsIdleOnTurnCompletion?: boolean;
  readonly supportsCompaction?: boolean;
  readonly runtimeHarness?: string;
  readonly registerExtensions?: (
    context: AcpAdapterV2ExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly extractSubagentSessionEvent?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => AcpSubagentSessionEvent | undefined;
  readonly extractSubagentUpdate?: (
    toolCall: AcpToolCallState,
  ) => AcpAdapterV2SubagentUpdate | undefined;
  readonly isProvisionalSubagentTool?: (toolCall: AcpToolCallState) => boolean;
  readonly normalizeToolCall?: (toolCall: AcpToolCallState) => AcpToolCallState;
  readonly extractProposedPlanMarkdown?: (toolCall: AcpToolCallState) => string | undefined;
  readonly extractBackgroundTaskId?: (toolCall: AcpToolCallState) => string | undefined;
  /** Distinguishes commands from monitors when lifecycle notifications omit their kind. */
  readonly isBackgroundCommandTool?: (toolCall: AcpToolCallState) => boolean;
  readonly extractBackgroundToolMutation?: (text: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  readonly extractSubagentEndNotice?: (text: string) =>
    | {
        readonly childSessionId: string;
        readonly status: "completed" | "failed";
      }
    | undefined;
  readonly extractBackgroundTaskCompletion?: (toolCall: AcpToolCallState) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  readonly isPersistentBackgroundTool?: (toolCall: AcpToolCallState) => boolean;
  readonly isProviderWakeNotification?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => boolean;
  readonly deferFinalizeForBackgroundWork?: boolean;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Interrupt the local prompt fiber before `session/cancel` (Grok wedged prompts). */
  readonly interruptPromptOnCancel?: boolean;
  /**
   * The agent's PromptResponse.usage counters read per-turn. The ACP spec
   * leaves usage semantics open, so this stays unset until proven live.
   */
  readonly reportsPerTurnPromptUsage?: boolean;
  /** Gemini-style usage: inputTokens leaves out cachedReadTokens, outputTokens leaves out thoughtTokens. */
  readonly geminiPromptUsage?: boolean;
  /**
   * Fails a dispatched prompt after this long with no update for its session while no
   * agent request, tool or subagent is open, and replaces the agent before the next turn.
   */
  readonly promptInactivityTimeout?: Duration.Input;
  /** Grok can retain task_already_running until process exit. */
  readonly restartRuntimeAfterInterrupt?: boolean;
  /** Prompt failures after which the agent process keeps failing until replaced. */
  readonly restartRuntimeAfterPromptError?: (error: unknown) => boolean;
  readonly restartRuntimeOnEveryInterrupt?: boolean;
  readonly terminateRuntimeProcessGroupOnInterrupt?: boolean;
  readonly preserveRuntimeOnSettledInterrupt?: boolean;
  readonly enablePostSettleContinuation?: boolean;
  /** Settle on native idle after the accepted user echo, only on negotiated ACP v2. */
  readonly followAgentWorkState?: boolean;
  /**
   * Grok CLI currently accepts and vision-processes image blocks while still
   * reporting the capability as false; without this override, screenshot turns
   * fail before `session/prompt`.
   */
  readonly supportsImagePrompts?: boolean;
}

export type AcpSubagentSessionEvent =
  | {
      readonly type: "state";
      readonly childSessionId: string;
      readonly parentSessionId: string;
      readonly status: "running" | "completed" | "failed" | "cancelled";
      readonly result: string | null;
    }
  | {
      readonly type: "delegation";
      readonly childSessionId: string;
      readonly parentSessionId: string | null;
      readonly delegationId: string;
      readonly prompt: string;
    };

export interface AcpAdapterV2SubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status:
    | "pending"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly childSessionId: string | null;
  readonly result: string | null;
  readonly suppressNormalTool?: boolean;
}

export interface AcpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly flavor: AcpAdapterV2Flavor;
  readonly selfInvocation: SelfInvocation;
  readonly clientTerminals?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly shellCommands?: boolean;
  };
  readonly nativeLogging?: (threadId: ThreadId) => AcpAdapterV2NativeLogging;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
  readonly testHooks?: {
    readonly onDeferredFinalizeScheduled?: (debounce: Duration.Input) => Effect.Effect<void>;
    /** Wire signal is set; the completion callback has not requested its permit yet. */
    readonly afterPromptWireSettled?: () => Effect.Effect<void>;
    readonly afterPromptSettledWithBackgroundWork?: () => Effect.Effect<void>;
    /** Terminal events, carryover cleanup, and the completion signal are finished. */
    readonly afterTurnFinalized?: () => Effect.Effect<void>;
    readonly afterNativeResponseTransportClosed?: () => Effect.Effect<void>;
    readonly afterHardTeardownTransportDrained?: () => Effect.Effect<void>;
    readonly beforeNativeResponseAdmissionCheck?: (
      generation: number,
      requestId: string,
    ) => Effect.Effect<void>;
    readonly onNativeResponseLifecycle?: (event: {
      readonly generation?: number;
      readonly requestId?: string;
      readonly type:
        | "admission_rejected"
        | "failed"
        | "late_noop"
        | "registered"
        | "removed"
        | "timer_exited"
        | "timer_started"
        | "watcher_exited"
        | "watcher_started";
    }) => Effect.Effect<void>;
  };
}
