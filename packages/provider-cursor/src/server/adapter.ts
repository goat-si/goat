import type { InteractionUpdate, RunResult, SDKUserMessage, ToolCall } from "@cursor/sdk";
import { formatReadToolLabel, formatSearchToolLabel } from "@goat/shared/toolActivity";
import * as HostProcess from "@goat/shared/HostProcess";
import { cursorToolOutput } from "./toolOutput.ts";
import {
  cursorToolFailed,
  cursorToolOutputText,
  cursorToolName,
  cursorToolFileName,
  cursorToolSearchPattern,
  cursorToolSearchResults,
} from "./toolPresentation.ts";
import {
  isOrchestrationV2WorkActive,
  defaultInstanceIdForDriver,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProviderModel,
  type ThreadId,
} from "@goat/contracts";
import { CursorSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@goat/provider-core/server/mcpToolPresentation";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { CursorTransportFailure } from "./transportFailure.ts";
import {
  cursorMcpServers,
  cursorSubagentsDisabled,
  makeCursorAgentOptions,
} from "./agentOptions.ts";
import { cursorContextWindowTokens, cursorSdkModelSelection } from "./sdkModel.ts";
import { makeCursorSkillTextResolver } from "./skills.ts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { goatOrchestrationPromptForFirstRun } from "@goat/provider-core/server/orchestrationInstructions";
import { buildCursorRuntimeInstructions } from "./screenInstructions.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@goat/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@goat/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@goat/provider-core/server/adapterDriver";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@goat/provider-core/server/subagentProjection";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  addCursorTurnUsage,
  type CursorProjectionTarget,
  type ActiveCursorToolCall,
  type ActiveCursorSubagent,
  type ActiveCursorTextStream,
  type ActiveCursorTurn,
} from "./activeTurn.ts";
import { isCursorSdkError } from "./sdk.ts";
import { cursorRunPrompt, type CursorRunPrompt } from "./steerPrompt.ts";
import {
  assistantTextsFromConversationSteps,
  cursorTodoSteps,
  textFromAgentMessage,
  toolCallsFromConversationSteps,
} from "./conversationSteps.ts";
export { cursorSdkModelSelection } from "./sdkModel.ts";
export { cursorMcpServers, makeCursorAgentOptions } from "./agentOptions.ts";

export const CURSOR_DRIVER_KIND = CursorAgentSdk.CURSOR_PROVIDER;
export const CURSOR_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CURSOR_DRIVER_KIND);
const DEFAULT_CURSOR_SETTINGS = Schema.decodeSync(CursorSettings)({});

export const CursorProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    // A steer can move a foreground subagent to the background. Mailbox wakes
    // stay queued so a notification does not cut into the live turn.
    activeSteeringInterruptsTools: true,
    activeSteeringAcceptsAttachments: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CursorProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly storeCwd: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    nativeMetadata: { cursorStoreCwd: input.storeCwd },
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const id = providerThread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined) {
    throw new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing its Cursor agent id.`,
    });
  }
  return id;
}

class CursorModelUnavailableError extends Schema.TaggedError<CursorModelUnavailableError>()(
  "CursorModelUnavailableError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor cannot run the model "${this.model}". Cursor only runs models from your Cursor account. Choose one of those, or use OpenCode for OpenRouter and other API-key models.`;
  }
}

// Uncoded SDK model rejections are identifiable only by message prefix.
const classifyCursorModelRejection =
  (modelSelection: ModelSelection) => (error: CursorAgentSdk.CursorAgentSdkRunnerError) =>
    isCursorSdkError(error.cause, "ConfigurationError") &&
    error.cause.message.startsWith("Cannot use this model:")
      ? new CursorModelUnavailableError({ model: modelSelection.model, cause: error.cause })
      : error;

// Cursor results can omit output; retain more streamed fallback than the persisted tail.
const MAX_CURSOR_STREAMED_OUTPUT_CHARS = 256 * 1024;
// After a turn ends, a retryable stream error can make Cursor's SDK resume from
// an older checkpoint inside the same run. When those resumes save nothing, it
// ends the run with this error even though the answer was already delivered.
const CURSOR_RESUME_NO_PROGRESS_MESSAGE =
  "Agent turn stopped after repeated resume attempts made no progress";

interface CursorLiveAgent {
  readonly cwd: string | null;
  readonly mcpAuthorization: string | undefined;
  readonly mcpEndpoint: string | undefined;
  /** The Cua Driver the agent was opened with (`cuaDriverKey`); empty when none. */
  readonly cuaDriverKey: string;
  readonly subagentsDisabled: boolean;
  readonly nativeThreadId: string;
  readonly storeCwd: string;
  readonly session: CursorAgentSdk.CursorAgentSdkSession;
}

export interface CursorAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CursorSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly getModels?: () => ReadonlyArray<ServerProviderModel>;
}

export const makeCursorAdapterV2 = Effect.fn("makeCursorAdapterV2")(function* (
  options: CursorAdapterV2Options,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
  const platform = yield* HostProcess.Platform;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  // Native history survives transport/session reopening. Unknown IDs stay silent until
  // this adapter has advertised tools; no conversation or memory body is retained here.
  const memoryToolClaims = new Set<string>();
  const adapterOptions = options;
  const apiKey = adapterOptions.environment.CURSOR_API_KEY?.trim() || undefined;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    getCapabilities: Effect.fn("CursorAdapter.getCapabilities")(function () {
      return Effect.succeed(CursorProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CursorAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CursorAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const createdAt = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now: createdAt,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const liveAgent = yield* Ref.make<CursorLiveAgent | null>(null);
        // Cursor drops a cancelled run from the conversation, so the next message carries its prompt.
        const interruptedPrompt = yield* Ref.make<{
          readonly agent: string;
          readonly prompt: CursorRunPrompt;
        } | null>(null);
        const warnedUnsupportedSandbox = yield* Ref.make(false);
        const activeTurn = yield* Ref.make<ActiveCursorTurn | null>(null);
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());

        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const resolveItemOrdinal = (context: ActiveCursorTurn, nativeItemId: string) =>
          Effect.sync(() => {
            const existing = context.itemOrdinals.get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }
            const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
            context.itemOrdinals.set(nativeItemId, ordinal);
            return ordinal;
          });

        const resolvePlanId = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(planIds)).get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const planId = yield* idAllocator.allocate.plan({
            threadId: context.input.threadId,
            runId: context.input.runId,
            driver: CursorAgentSdk.CURSOR_PROVIDER,
          });
          yield* Ref.update(planIds, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, planId);
            return updated;
          });
          return planId;
        });

        const parentTarget = (context: ActiveCursorTurn): CursorProjectionTarget => ({
          threadId: context.input.threadId,
          runId: context.input.runId,
          rootNodeId: context.input.rootNodeId,
          parentNodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
        });

        const emitAssistant = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.assistant.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "assistant_message",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            message: {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              role: "assistant",
              text: segment.text,
              attachments: [],
              streaming: !completed,
              createdAt: segment.startedAt,
              updatedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "assistant_message",
              messageId,
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const emitReasoning = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.reasoning.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "reasoning",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "reasoning",
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const appendTextSegment = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly stream: ActiveCursorTextStream;
          readonly kind: "assistant" | "reasoning";
          readonly text: string;
        }) {
          if (input.stream.current === null) {
            input.stream.nextSegment += 1;
            input.stream.current = {
              nativeItemId: `${input.kind}:${input.context.run.runId}:${input.stream.nextSegment}`,
              startedAt: yield* DateTime.now,
              text: "",
            };
          }
          input.stream.current.text += input.text;
        });

        const completeAssistant = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.assistant.current === null) {
            return;
          }
          yield* emitAssistant(context, true);
          context.assistant.current = null;
        });

        const completeReasoning = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.reasoning.current === null) {
            return;
          }
          yield* emitReasoning(context, true);
          context.reasoning.current = null;
        });

        const emitToolArtifacts = Effect.fnUntraced(function* (input: {
          readonly active: ActiveCursorToolCall;
          readonly completed: boolean;
          readonly unfinishedStatus?: "interrupted" | "failed" | "cancelled";
        }) {
          const { active } = input;
          const toolCall = active.toolCall;
          const now = yield* DateTime.now;
          const failed = input.completed && cursorToolFailed(toolCall);
          const status = !input.completed
            ? "running"
            : (input.unfinishedStatus ?? (failed ? "failed" : "completed"));
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: active.callId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            parentNodeId: active.target.parentNodeId,
            rootNodeId: active.target.rootNodeId,
            kind: "tool_call",
            status,
            countsForRun: false,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
          };
          const base = {
            id: turnItemId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            nodeId,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: active.ordinal,
            status,
            title: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
            updatedAt: now,
          } satisfies Pick<
            OrchestrationV2TurnItem,
            | "id"
            | "threadId"
            | "runId"
            | "nodeId"
            | "providerThreadId"
            | "providerTurnId"
            | "nativeItemRef"
            | "parentItemId"
            | "ordinal"
            | "status"
            | "title"
            | "startedAt"
            | "completedAt"
            | "updatedAt"
          >;
          const outputText = cursorToolOutputText(toolCall) || active.streamedOutput;
          let turnItem: OrchestrationV2TurnItem;
          switch (toolCall.type) {
            case "shell":
              turnItem = {
                ...base,
                type: "command_execution",
                input: toolCall.args.command,
                ...(outputText.length === 0 ? {} : { output: outputText }),
                ...(toolCall.result?.status === "success"
                  ? { exitCode: toolCall.result.value.exitCode }
                  : {}),
              };
              break;
            case "write":
            case "delete":
            case "edit":
            case "generateImage":
              turnItem = {
                ...base,
                type: "file_change",
                fileName: cursorToolFileName(toolCall),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesAdded !== undefined
                  ? { additions: toolCall.result.value.linesAdded }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesRemoved !== undefined
                  ? { deletions: toolCall.result.value.linesRemoved }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.diffString !== undefined
                  ? { diffStr: toolCall.result.value.diffString }
                  : toolCall.result?.status === "error" && outputText.trim().length > 0
                    ? { diffStr: outputText }
                    : {}),
                ...(toolCall.type === "write" ? { newStr: toolCall.args.fileText } : {}),
              };
              break;
            case "read":
              turnItem = {
                ...base,
                title: formatReadToolLabel(toolCall.args.path),
                type: "dynamic_tool",
                toolName: "Read",
                input: toolCall.args,
                ...(cursorToolOutput(toolCall) === undefined
                  ? {}
                  : { output: cursorToolOutput(toolCall) }),
              };
              break;
            case "glob":
            case "grep":
            case "ls":
            case "readLints":
            case "semSearch": {
              const pattern = cursorToolSearchPattern(toolCall);
              const searchPath =
                toolCall.type === "grep"
                  ? toolCall.args.path
                  : toolCall.type === "glob"
                    ? toolCall.args.targetDirectory
                    : toolCall.type === "semSearch"
                      ? toolCall.args.targetDirectories?.join(", ")
                      : pattern;
              const results =
                toolCall.result?.status === "error" && outputText.trim().length > 0
                  ? [{ fileName: searchPath?.trim() || ".", preview: outputText }]
                  : cursorToolSearchResults(toolCall, path);
              turnItem = {
                ...base,
                title:
                  formatSearchToolLabel({
                    input: toolCall.args,
                    ...(pattern === undefined ? {} : { pattern }),
                  }) ?? null,
                type: "file_search",
                ...(pattern === undefined ? {} : { pattern }),
                ...(results.length === 0 ? {} : { results: [...results] }),
              };
              break;
            }
            default:
              turnItem = {
                ...base,
                type: "dynamic_tool",
                ...(toolCall.type === "mcp"
                  ? mcpToolPresentation({
                      serverName: toolCall.args.providerIdentifier,
                      toolName: toolCall.args.toolName,
                    })
                  : {}),
                toolName: cursorToolName(toolCall),
                input: toolCall.type === "mcp" ? (toolCall.args.args ?? {}) : toolCall.args,
                ...(cursorToolOutput(toolCall) === undefined
                  ? {}
                  : { output: cursorToolOutput(toolCall) }),
              };
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem,
          });
        });

        const ensureToolStarted = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          callId: string,
          toolCall: ToolCall,
        ) {
          const existing = context.tools.get(callId);
          if (existing !== undefined) {
            existing.toolCall = toolCall;
            return existing;
          }
          const startedAt = yield* DateTime.now;
          const active: ActiveCursorToolCall = {
            callId,
            toolCall,
            target: parentTarget(context),
            ordinal: yield* resolveItemOrdinal(context, callId),
            startedAt,
            streamedOutput: "",
          };
          context.tools.set(callId, active);
          yield* emitToolArtifacts({ active, completed: false });
          return active;
        });

        const emitPlanArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly markdown: string;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `plan:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          const plan: OrchestrationV2PlanArtifact = {
            id: planId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            kind: "proposed_plan",
            status: input.completed ? "active" : "draft",
            markdown: input.markdown,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "plan",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            plan,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "proposed_plan",
              planId,
              markdown: input.markdown,
              streaming: !input.completed,
            },
          });
        });

        const emitTodoArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `todos:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const steps = cursorTodoSteps(input.toolCall);
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "todo_list",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            plan: {
              id: planId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              kind: "todo_list",
              status: input.completed ? "active" : "draft",
              steps: [...steps],
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps: [...steps],
            },
          });
        });

        const emitSubagent = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "task" }>;
          readonly completed: boolean;
          readonly status?: OrchestrationV2Subagent["status"];
        }) {
          const args = input.toolCall.args;
          const result =
            input.toolCall.result?.status === "success" ? input.toolCall.result.value : undefined;
          const existing = input.context.subagents.get(input.callId);
          if (
            existing !== undefined &&
            !isOrchestrationV2WorkActive(existing.task.status) &&
            !input.completed
          )
            return;
          const now = yield* DateTime.now;
          const status: OrchestrationV2Subagent["status"] =
            input.status ??
            (input.completed
              ? cursorToolFailed(input.toolCall)
                ? "failed"
                : "completed"
              : "running");
          const resultText = [
            ...assistantTextsFromConversationSteps(result?.conversationSteps ?? []),
            ...(result?.resultSuffix === undefined ? [] : [result.resultSuffix]),
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");
          const nativeItemId = input.callId;
          const nodeId =
            existing?.task.id ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeItemId,
            });
          const childRootNodeId =
            existing?.childRootNodeId ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeItemId: `${nativeItemId}:child-root`,
            });
          const childThreadId =
            existing?.childThreadId ??
            idAllocator.derive.subagentThread({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeThreadId: `${input.context.run.runId}:task:${input.callId}`,
            });
          const task: OrchestrationV2Subagent = {
            ...(existing?.task ?? {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: {
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeId: input.callId,
                strength: "strong" as const,
              },
              prompt: args.prompt,
              title: args.description,
              result: null,
              startedAt: now,
            }),
            model: args.model?.trim() || existing?.task.model || null,
            nativeTaskRef: {
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeId: input.callId,
              strength: "strong" as const,
            },
            status,
            result: resultText.length === 0 ? (existing?.task.result ?? null) : resultText,
            completedAt: input.completed ? (existing?.task.completedAt ?? now) : null,
            updatedAt: now,
          };
          const subagent: ActiveCursorSubagent = {
            task,
            toolCall: input.toolCall,
            callId: input.callId,
            childThreadId,
            childRootNodeId,
            turnItemId:
              existing?.turnItemId ??
              idAllocator.derive.turnItemFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId,
              }),
            turnItemOrdinal:
              existing?.turnItemOrdinal ?? (yield* resolveItemOrdinal(input.context, nativeItemId)),
            nextChildOrdinal: existing?.nextChildOrdinal ?? 100,
            resultProjected: existing?.resultProjected ?? false,
          };
          input.context.subagents.set(input.callId, subagent);

          if (existing === undefined) {
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              appThread: makeSubagentChildThread({
                parentThread: input.context.input.appThread,
                childThreadId,
                parentNodeId: nodeId,
                activeProviderThreadId: null,
                providerInstanceId: input.context.input.modelSelection.instanceId,
                modelSelection: input.context.input.modelSelection,
                title: subagentThreadTitle({
                  parentTitle: input.context.input.appThread.title,
                  title: args.description,
                  prompt: args.prompt,
                  ordinal: input.context.subagents.size,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              }),
            });
            const promptNativeId = `${nativeItemId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              senderThreadId: input.context.input.threadId,
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: {
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeId: promptNativeId,
                strength: "weak",
              },
              role: "user",
              text: args.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }

          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "subagent",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status,
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            subagent: task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: subagent.turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              parentItemId: null,
              ordinal: subagent.turnItemOrdinal,
              status,
              title: task.title,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: task.id,
              origin: task.origin,
              driver: task.driver,
              providerInstanceId: task.providerInstanceId,
              childThreadId,
              prompt: task.prompt,
              result: task.result,
            },
          });

          if (input.completed && !subagent.resultProjected) {
            for (const [index, nestedTool] of toolCallsFromConversationSteps(
              result?.conversationSteps ?? [],
            ).entries()) {
              const callId = `${nativeItemId}:child-tool:${nestedTool.callId || index + 1}`;
              const startedAt = task.startedAt ?? now;
              const active: ActiveCursorToolCall = {
                callId,
                toolCall: nestedTool.toolCall,
                target: {
                  threadId: childThreadId,
                  runId: null,
                  rootNodeId: childRootNodeId,
                  parentNodeId: childRootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                },
                ordinal: ++subagent.nextChildOrdinal,
                startedAt,
                streamedOutput: "",
              };
              yield* emitToolArtifacts({ active, completed: true });
            }
            if (task.result !== null && task.result.length > 0) {
              const resultNativeId = `${nativeItemId}:result`;
              const resultArtifacts = makeSubagentConversationArtifacts({
                messageId: idAllocator.derive.messageFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: {
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeId: resultNativeId,
                  strength: "weak",
                },
                role: "assistant",
                text: task.result,
                ordinal: ++subagent.nextChildOrdinal,
                now,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                message: resultArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                turnItem: resultArtifacts.turnItem,
              });
            }
            subagent.resultProjected = true;
          }
        });

        const handleToolUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: Extract<
            InteractionUpdate,
            {
              readonly type: "tool-call-started" | "partial-tool-call" | "tool-call-completed";
            }
          >,
        ) {
          const completed = update.type === "tool-call-completed";
          const toolCall = update.toolCall;
          switch (toolCall.type) {
            case "createPlan":
              yield* emitPlanArtifacts({
                context,
                callId: update.callId,
                markdown: toolCall.args.plan,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "updateTodos":
              yield* emitTodoArtifacts({
                context,
                callId: update.callId,
                toolCall,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "task":
              if (update.type === "partial-tool-call") {
                return;
              }
              yield* emitSubagent({
                context,
                callId: update.callId,
                toolCall,
                completed,
              });
              return;
            default: {
              const active = yield* ensureToolStarted(context, update.callId, toolCall);
              active.toolCall = toolCall;
              if (update.type !== "tool-call-started") {
                yield* emitToolArtifacts({ active, completed });
              }
              if (completed) {
                context.tools.delete(update.callId);
              }
            }
          }
        });

        const shellOutputText = (event: Record<string, unknown>): string => {
          const candidates = [
            event.text,
            event.output,
            event.data,
            event.stdout,
            event.stderr,
            event.chunk,
          ];
          return candidates.filter((value): value is string => typeof value === "string").join("");
        };

        const handleInteractionUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: InteractionUpdate,
        ) {
          if (context.finalized) {
            return;
          }
          if (update.type === "turn-ended") {
            context.turnEnded = true;
            if (update.usage !== undefined) {
              context.usage = addCursorTurnUsage(context.usage, update.usage);
            }
          } else if (
            update.type === "step-started" ||
            update.type === "user-message-appended" ||
            update.type === "text-delta" ||
            update.type === "thinking-delta" ||
            update.type === "partial-tool-call" ||
            update.type === "tool-call-started"
          ) {
            context.turnEnded = false;
          }
          switch (update.type) {
            case "text-delta":
              // Classify each assistant message on its own, so earlier
              // commentary does not hide a later standalone transport dump.
              if (context.assistant.current === null) {
                context.assistantReply = new CursorTransportFailure();
              }
              context.assistantReply.push(update.text);
              yield* completeReasoning(context);
              yield* appendTextSegment({
                context,
                stream: context.assistant,
                kind: "assistant",
                text: update.text,
              });
              yield* emitAssistant(context, false);
              return;
            case "thinking-delta":
              yield* completeAssistant(context);
              yield* appendTextSegment({
                context,
                stream: context.reasoning,
                kind: "reasoning",
                text: update.text,
              });
              yield* emitReasoning(context, false);
              return;
            case "thinking-completed":
              yield* completeReasoning(context);
              return;
            case "tool-call-started":
            case "partial-tool-call":
            case "tool-call-completed":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              yield* handleToolUpdate(context, update);
              return;
            case "step-completed":
            case "turn-ended":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              return;
            case "shell-output-delta": {
              const shell = Array.from(context.tools.values())
                .toReversed()
                .find((candidate) => candidate.toolCall.type === "shell");
              if (shell === undefined) {
                return;
              }
              const chunk = shellOutputText(update.event);
              if (chunk.length === 0) return;
              // Persist output once; live hub deltas avoid quadratic event-store growth.
              shell.streamedOutput = (shell.streamedOutput + chunk).slice(
                -MAX_CURSOR_STREAMED_OUTPUT_CHARS,
              );
              yield* emitProviderEvent({
                type: "command_output.delta",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                threadId: shell.target.threadId,
                itemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: shell.callId,
                }),
                chunk,
              });
              return;
            }
            default:
              return;
          }
        });

        const providerTurnPayload = (input: {
          readonly context: ActiveCursorTurn;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly completedAt: DateTime.Utc | null;
          readonly tokenUsage?: OrchestrationV2ProviderTurn["tokenUsage"];
        }): OrchestrationV2ProviderTurn => ({
          id: input.context.providerTurnId,
          providerThreadId: input.context.input.providerThread.id,
          nodeId: input.context.input.rootNodeId,
          runAttemptId: input.context.input.attemptId,
          nativeTurnRef: {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: input.context.run.runId,
            strength: "strong",
          },
          ordinal: input.context.input.providerTurnOrdinal,
          status: input.status,
          startedAt: input.context.startedAt,
          completedAt: input.completedAt,
          ...(input.tokenUsage === undefined ? {} : { tokenUsage: input.tokenUsage }),
          ...(input.completedAt === null || input.context.usage === undefined
            ? {}
            : {
                turnTokenUsage: {
                  usageScope: "main_agent",
                  usageStatus: input.status === "completed" ? "complete" : "partial",
                  // Cursor's inputTokens already include cache reads and writes.
                  inputTokens: input.context.usage.inputTokens,
                  cachedInputTokens: input.context.usage.cacheReadTokens,
                  cacheCreationTokens: input.context.usage.cacheWriteTokens,
                  outputTokens: input.context.usage.outputTokens,
                  ...(input.context.usage.reasoningTokens === undefined
                    ? {}
                    : { reasoningTokens: input.context.usage.reasoningTokens }),
                  hasSubagents: input.context.subagents.size > 0,
                },
              }),
        });

        const finalizeTurn = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly status: Extract<
            OrchestrationV2ProviderTurn["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          >;
          readonly failure?: OrchestrationV2ProviderFailure;
          readonly threadDisposition?: "reusable" | "broken";
        }) {
          if (input.context.finalized) {
            return;
          }
          input.context.finalized = true;
          const completedAt = yield* DateTime.now;
          for (const tool of input.context.tools.values()) {
            yield* emitToolArtifacts({
              active: tool,
              completed: true,
              // No completion event means the tool outcome is unknown.
              unfinishedStatus: input.status === "completed" ? "interrupted" : input.status,
            });
          }
          input.context.tools.clear();
          for (const subagent of input.context.subagents.values()) {
            if (!isOrchestrationV2WorkActive(subagent.task.status)) continue;
            yield* emitSubagent({
              context: input.context,
              callId: subagent.callId,
              toolCall: subagent.toolCall,
              completed: true,
              status: input.status === "completed" ? "idle" : input.status,
            });
          }
          yield* completeReasoning(input.context);
          yield* completeAssistant(input.context);
          // The turn's billed totals count every step; only the checkpoint knows the context fill.
          const contextUsage = yield* (
            input.context.session.readContextUsage ?? Effect.undefined
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration-v2.cursor-context-usage-unavailable", {
                providerTurnId: input.context.providerTurnId,
                cause,
              }).pipe(Effect.as(undefined)),
            ),
          );
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerTurn: providerTurnPayload({
              context: input.context,
              status: input.status,
              completedAt,
              ...(contextUsage === undefined
                ? {}
                : {
                    tokenUsage: {
                      usedTokens: contextUsage.usedTokens,
                      maxTokens: contextUsage.maxTokens,
                      updatedAt: DateTime.formatIso(completedAt),
                    },
                  }),
            }),
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerThread: {
              ...input.context.input.providerThread,
              providerSessionId: session.id,
              status: "active",
              firstRunOrdinal:
                input.context.input.providerThread.firstRunOrdinal ??
                input.context.input.runOrdinal,
              lastRunOrdinal: input.context.input.runOrdinal,
              updatedAt: completedAt,
            },
          });
          const threadDisposition = input.threadDisposition ?? "reusable";
          yield* emitProviderEvent(
            input.status === "failed"
              ? {
                  type: "turn.terminal",
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  providerThreadId: input.context.input.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  runOrdinal: input.context.input.runOrdinal,
                  failureItemOrdinal: yield* resolveItemOrdinal(
                    input.context,
                    `terminal-failure:${input.context.providerTurnId}`,
                  ),
                  status: input.status,
                  failure: input.failure ?? makeProviderFailure({ class: "provider_error" }),
                  threadDisposition,
                }
              : {
                  type: "turn.terminal",
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  providerThreadId: input.context.input.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  runOrdinal: input.context.input.runOrdinal,
                  status: input.status,
                  failure: null,
                  threadDisposition,
                },
          );
          if (input.status === "interrupted" && input.context.prompt !== undefined) {
            yield* Ref.set(interruptedPrompt, {
              agent: input.context.run.agentId,
              prompt: input.context.prompt,
            });
          }
          yield* Ref.update(activeTurn, (current) =>
            current?.providerTurnId === input.context.providerTurnId ? null : current,
          );
          yield* Deferred.succeed(input.context.completed, undefined);
        });

        const isResumeFailureAfterTurnEnded = (context: ActiveCursorTurn, result: RunResult) =>
          context.turnEnded &&
          result.status === "error" &&
          result.error?.message === CURSOR_RESUME_NO_PROGRESS_MESSAGE;

        const terminalStatus = (
          context: ActiveCursorTurn,
          result: RunResult,
        ): Extract<
          OrchestrationV2ProviderTurn["status"],
          "completed" | "interrupted" | "failed" | "cancelled"
        > => {
          if (context.interrupted) {
            return "interrupted";
          }
          switch (result.status) {
            case "finished":
              return "completed";
            case "cancelled":
              return "cancelled";
            case "error":
              return isResumeFailureAfterTurnEnded(context, result) ? "completed" : "failed";
          }
        };

        const openAgent = Effect.fnUntraced(function* (
          openInput: CursorAgentSdk.CursorAgentOpenTarget & {
            readonly threadId: ThreadId;
            readonly modelSelection: ModelSelection;
            readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
            readonly storeCwd?: string | undefined;
          },
        ) {
          const existing = yield* Ref.get(liveAgent);
          const mcpSession = yield* mcpSessions.read(openInput.threadId);
          const cwd = openInput.runtimePolicy.cwd ?? process.cwd();
          const storeCwd =
            openInput.storeCwd ??
            (openInput.operation === "resume"
              ? existing !== null && existing.nativeThreadId === openInput.agentId
                ? existing.storeCwd
                : input.resumeFromSession?.cwd
              : undefined) ??
            cwd;
          if (
            existing !== null &&
            openInput.operation === "resume" &&
            existing.nativeThreadId === openInput.agentId &&
            existing.cwd === openInput.runtimePolicy.cwd &&
            existing.mcpAuthorization === mcpSession?.authorizationHeader &&
            existing.mcpEndpoint === mcpSession?.endpoint &&
            // Servers are fixed when the agent opens; computer use changes reopen it.
            existing.cuaDriverKey === McpProviderSession.cuaDriverKey(mcpSession?.cuaDriver) &&
            existing.subagentsDisabled === cursorSubagentsDisabled(mcpSession)
          ) {
            return existing;
          }
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          const options = makeCursorAgentOptions({
            ...(apiKey === undefined ? {} : { apiKey }),
            modelSelection: openInput.modelSelection,
            models: adapterOptions.getModels?.() ?? [],
            runtimePolicy: openInput.runtimePolicy,
            platform,
            threadId: openInput.threadId,
            mcpSession,
          });
          if (
            platform === "win32" &&
            openInput.runtimePolicy.sandboxPolicy === undefined &&
            openInput.runtimePolicy.runtimeMode !== "full-access" &&
            options.local?.sandboxOptions?.enabled === false &&
            !(yield* Ref.getAndSet(warnedUnsupportedSandbox, true))
          ) {
            yield* Effect.logWarning(
              "Cursor cannot sandbox the filesystem on Windows; this thread runs without filesystem isolation.",
            );
          }
          const sdkSession = yield* runner
            .open({
              ...(openInput.operation === "create"
                ? { operation: "create" as const }
                : { operation: "resume" as const, agentId: openInput.agentId }),
              storeCwd,
              options,
              threadId: openInput.threadId,
              providerSessionId: input.providerSessionId,
            })
            .pipe(Effect.mapError(classifyCursorModelRejection(openInput.modelSelection)));
          if (openInput.operation === "create") memoryToolClaims.delete(sdkSession.agentId);
          const next = {
            cwd: openInput.runtimePolicy.cwd,
            nativeThreadId: sdkSession.agentId,
            storeCwd,
            session: sdkSession,
            mcpAuthorization: mcpSession?.authorizationHeader,
            mcpEndpoint: mcpSession?.endpoint,
            cuaDriverKey: McpProviderSession.cuaDriverKey(mcpSession?.cuaDriver),
            subagentsDisabled: cursorSubagentsDisabled(mcpSession),
          } satisfies CursorLiveAgent;
          yield* Ref.set(liveAgent, next);
          return next;
        });
        const resolveCursorSkillText = makeCursorSkillTextResolver(adapterOptions.environment);
        const resolveUserMessage = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          config: McpProviderSession.McpProviderSessionConfig | undefined,
          memoryClaim: { claimed: boolean },
          interrupted: CursorRunPrompt | undefined,
        ) {
          const rawText = turnInput.message.text;
          if (rawText.trim() === "/compress" && turnInput.message.attachments.length === 0) {
            return { message: "/compress", prompt: undefined };
          }
          const newText = yield* providerMessageTextWithAttachmentPaths({
            text: yield* resolveCursorSkillText(
              rawText,
              turnInput.runtimePolicy.cwd ?? undefined,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
            attachments: turnInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          });
          const prompt = cursorRunPrompt(newText, turnInput.runOrdinal, interrupted);
          const userText = goatOrchestrationPromptForFirstRun({
            prompt: prompt.text,
            runOrdinal: prompt.runOrdinal,
            hasGoatMcp: config !== undefined,
            browser: config?.browserToolsAvailable,
          });
          const images = yield* Effect.forEach(
            turnInput.message.attachments.filter(isProviderNativeImageAttachment),
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = host.resolveAttachmentPath(attachment);
                if (path === null) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(path).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        detail: `Failed to read attachment '${attachment.id}'.`,
                        reason: "attachment_unreadable",
                        payload: cause,
                      }),
                  ),
                );
                return {
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                };
              }),
            { concurrency: 1 },
          );
          if (userText.length === 0 && images.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              detail: "Cursor turn requires non-empty text or attachments.",
            });
          }
          const snapshot = turnInput.refreshMemoryContext
            ? yield* turnInput.refreshMemoryContext()
            : turnInput.memoryContext;
          const memory =
            snapshot === undefined
              ? undefined
              : yield* Effect.try({
                  try: () => MemoryContext.memoryContextText(snapshot),
                  catch: () =>
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      detail: "Invalid memory context frame",
                    }),
                });
          const agent = yield* Ref.get(liveAgent);
          const availability = McpProviderSession.memoryToolAvailability(config);
          const hasMemoryTools = availability.read || availability.write || availability.source;
          const nativeId = agent!.nativeThreadId;
          const announceMemoryTools = hasMemoryTools || memoryClaim.claimed;
          // Record admission, including attempts whose native response later fails.
          if (hasMemoryTools) {
            memoryClaim.claimed = true;
            memoryToolClaims.add(nativeId);
          } else memoryToolClaims.delete(nativeId);
          const text = [
            userText,
            buildCursorRuntimeInstructions(config, {
              harness: "Cursor",
              model: turnInput.modelSelection.model,
              computerUse:
                agent !== null &&
                agent.cuaDriverKey !== "" &&
                McpProviderSession.carriesComputerUseSkill(config),
            }),
            announceMemoryTools
              ? `GOAT memory tools: read=${availability.read}, write=${availability.write}, source=${availability.source}. Unavailable or denied tools must not be claimed.`
              : undefined,
            memory,
          ]
            .filter((part) => part !== undefined)
            .join("\n\n");
          return {
            message: images.length === 0 ? text : ({ text, images } satisfies SDKUserMessage),
            prompt,
          };
        });

        const startTurn = Effect.fn("CursorAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            const current = yield* Ref.get(activeTurn);
            if (current !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                detail: `Cursor provider turn ${current.providerTurnId} is still active.`,
                reason: "previous_turn_active",
              });
            }
            const agentId = nativeThreadId(turnInput.providerThread);
            const agent = yield* openAgent({
              operation: "resume",
              agentId,
              storeCwd: turnInput.providerThread.nativeMetadata?.cursorStoreCwd,
              threadId: turnInput.threadId,
              modelSelection: turnInput.modelSelection,
              runtimePolicy: turnInput.runtimePolicy,
            });
            const mcpSession = yield* mcpSessions.read(turnInput.threadId);
            const mcpServers = cursorMcpServers(mcpSession);
            // Keep the correction owed by this turn across native active-run recovery.
            const memoryClaim = { claimed: memoryToolClaims.has(agent.nativeThreadId) };
            const interrupted = yield* Ref.get(interruptedPrompt);
            const previous =
              interrupted?.agent === agent.nativeThreadId ? interrupted.prompt : undefined;
            const { message, prompt } = yield* resolveUserMessage(
              turnInput,
              mcpSession,
              memoryClaim,
              previous,
            );
            const compacted = prompt === undefined;
            const pendingUpdates: Array<InteractionUpdate> = [];
            let context: ActiveCursorTurn | null = null;
            const sdkRun = yield* agent.session
              .send({
                message,
                summarize: compacted,
                prepareMessage: () =>
                  Effect.gen(function* () {
                    const config = yield* mcpSessions.read(turnInput.threadId);
                    return {
                      message: (yield* resolveUserMessage(turnInput, config, memoryClaim, previous))
                        .message,
                      mcpServers: cursorMcpServers(config),
                    };
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new CursorAgentSdk.CursorAgentSdkRunnerError({
                          method: "run.prepareMessage",
                          cause,
                        }),
                    ),
                  ),
                options: {
                  model: cursorSdkModelSelection(
                    turnInput.modelSelection,
                    adapterOptions.getModels?.() ?? [],
                  ),
                  mode: turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
                  mcpServers: mcpServers ?? {},
                },
                onDelta: (update) => {
                  if (context === null) {
                    return Effect.sync(() => {
                      pendingUpdates.push(update);
                    });
                  }
                  return handleInteractionUpdate(context, update);
                },
              })
              .pipe(Effect.mapError(classifyCursorModelRejection(turnInput.modelSelection)));
            if (!compacted) yield* Ref.set(interruptedPrompt, null);
            const startedAt = yield* DateTime.now;
            const completed = yield* Deferred.make<void, never>();
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeTurnId: sdkRun.runId,
            });
            // SDK turn state owns routing/policy only, never an admission snapshot or closure.
            const {
              memoryContext: _memoryContext,
              refreshMemoryContext: _refreshMemoryContext,
              ...turnOwner
            } = turnInput;
            context = {
              input: turnOwner,
              run: sdkRun,
              providerTurnId,
              startedAt,
              completed,
              itemOrdinals: new Map(),
              tools: new Map(),
              subagents: new Map(),
              assistant: {
                current: null,
                nextSegment: 0,
              },
              assistantReply: new CursorTransportFailure(),
              reasoning: {
                current: null,
                nextSegment: 0,
              },
              prompt,
              interrupted: false,
              finalized: false,
              turnEnded: false,
              session: agent.session,
              usage: undefined,
            };
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerThread: {
                ...turnInput.providerThread,
                providerSessionId: session.id,
                status: "active",
                updatedAt: startedAt,
              },
            });
            for (const update of pendingUpdates) {
              yield* handleInteractionUpdate(context, update);
            }

            yield* sdkRun.wait.pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    context !== null &&
                    context.assistant.nextSegment === 0 &&
                    !compacted &&
                    // Text from a resume that made no progress is not the turn's answer.
                    !isResumeFailureAfterTurnEnded(context, result) &&
                    result.result !== undefined &&
                    result.result.length > 0
                  ) {
                    context.assistantReply.push(result.result);
                    yield* appendTextSegment({
                      context,
                      stream: context.assistant,
                      kind: "assistant",
                      text: result.result,
                    });
                  }
                  if (context !== null && isResumeFailureAfterTurnEnded(context, result)) {
                    yield* Effect.logWarning(
                      "orchestration-v2.cursor-resume-failed-after-turn-ended",
                      {
                        providerSessionId: input.providerSessionId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId,
                      },
                    );
                  }
                  if (context !== null) {
                    const transportFailure = context.assistantReply.failure;
                    const status =
                      transportFailure === undefined ? terminalStatus(context, result) : "failed";
                    yield* finalizeTurn({
                      context,
                      status,
                      ...(status === "failed"
                        ? {
                            failure:
                              transportFailure === undefined
                                ? makeProviderFailure({
                                    cause: result.error,
                                    // makeProviderFailure never reads a cause's own text.
                                    message: result.error?.message,
                                    class: CursorAgentSdk.isCursorUsageLimitError(result.error)
                                      ? "usage_limit"
                                      : "provider_error",
                                  })
                                : makeProviderFailure({
                                    cause: transportFailure,
                                    class: "transport_error",
                                  }),
                          }
                        : {}),
                    });
                  }
                }),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (context !== null) {
                    yield* finalizeTurn({
                      context,
                      status: context.interrupted ? "interrupted" : "failed",
                      ...(context.interrupted
                        ? {}
                        : {
                            failure: makeProviderFailure({
                              cause,
                              message: CursorAgentSdk.isCursorAgentSdkRunnerError(cause)
                                ? CursorAgentSdk.cursorSdkFailureMessage(cause)
                                : undefined,
                              class: CursorAgentSdk.isCursorUsageLimitError(cause)
                                ? "usage_limit"
                                : "transport_error",
                            }),
                          }),
                    });
                  }
                  yield* Effect.logWarning("orchestration-v2.cursor-run-failed", {
                    providerSessionId: input.providerSessionId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    cause,
                  });
                }),
              ),
              Effect.forkIn(sessionScope),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const closeSession = Effect.fnUntraced(function* () {
          const existing = yield* Ref.get(liveAgent);
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          yield* runner.assertComplete.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.cursor-runner-incomplete", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });
        yield* Effect.addFinalizer(() => closeSession());

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          getModelContextWindow: (selection) =>
            selection.instanceId === adapterOptions.instanceId
              ? cursorContextWindowTokens(selection, adapterOptions.getModels?.() ?? [])
              : undefined,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: Effect.fn("CursorAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
              const opened = yield* openAgent({
                operation: "create",
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId: opened.nativeThreadId,
                storeCwd: opened.storeCwd,
                now,
              });
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("CursorAdapterV2.resumeThread")(
            function* (threadInput: { readonly providerThread: OrchestrationV2ProviderThread }) {
              const agentId = nativeThreadId(threadInput.providerThread);
              const opened = yield* openAgent({
                operation: "resume",
                agentId,
                storeCwd: threadInput.providerThread.nativeMetadata?.cursorStoreCwd,
                threadId: threadInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return {
                ...threadInput.providerThread,
                nativeMetadata: {
                  ...threadInput.providerThread.nativeMetadata,
                  cursorStoreCwd: opened.storeCwd,
                },
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: now,
              };
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          compactThread: (turnInput) =>
            startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compress" },
            }),
          steerTurn: Effect.fn("CursorAdapterV2.steerTurn")(
            function* (turnInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
              const context = yield* Ref.get(activeTurn);
              if (
                context === null ||
                context.finalized ||
                context.providerTurnId !== turnInput.providerTurnId
              ) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: `Cursor provider turn ${turnInput.providerTurnId} is not active.`,
                });
              }
              // The live run already has the runtime instructions from startTurn.
              const text = yield* providerMessageTextWithAttachmentPaths({
                text: yield* resolveCursorSkillText(
                  turnInput.message.text,
                  context.input.runtimePolicy.cwd ?? undefined,
                ).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                ),
                attachments: turnInput.message.attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
                resolveExtractedTextPath: host.resolveExtractedTextPath,
              });
              if (text.trim().length === 0) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: "Cursor steer requires non-empty text.",
                });
              }
              const outcome =
                context.run.steer === undefined
                  ? "revert_to_followup"
                  : yield* context.run.steer(text);
              if (outcome === "complete_delivered") {
                return;
              }
              if (context.interrupted) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: "Cursor steer was interrupted before the run could take it.",
                });
              }
              return yield* new ProviderAdapter.ProviderAdapterSteerDeclinedError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId: turnInput.providerTurnId,
              });
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  cause._tag === "ProviderAdapterSteerDeclinedError"
                    ? cause
                    : new ProviderAdapter.ProviderAdapterSteerRunError({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId: turnInput.providerTurnId,
                        cause,
                      }),
                ),
              ),
          ),
          interruptTurn: Effect.fn("CursorAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
              const context = yield* Ref.get(activeTurn);
              if (context === null && turnInput.requestRuntimeRestart === true) return;
              if (context?.providerTurnId !== turnInput.providerTurnId) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: `Cursor provider turn ${turnInput.providerTurnId} is not active.`,
                });
              }
              context.interrupted = true;
              yield* context.run.cancel;
              const stopped = yield* Deferred.await(context.completed).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              if (Option.isSome(stopped)) {
                return;
              }
              yield* Effect.logWarning("orchestration-v2.cursor-interrupt-timeout", {
                providerSessionId: input.providerSessionId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId: turnInput.providerTurnId,
              });
              yield* finalizeTurn({ context, status: "interrupted" });
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                requestId: requestInput.requestId,
                cause: new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  detail: "Cursor Agent SDK does not expose interactive approval requests.",
                }),
              }),
            ),
          readThreadSnapshot: Effect.fn("CursorAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              const requestedAgentId = nativeThreadId(snapshotInput.providerThread);
              const agent = yield* openAgent({
                operation: "resume",
                agentId: requestedAgentId,
                storeCwd: snapshotInput.providerThread.nativeMetadata?.cursorStoreCwd,
                threadId: snapshotInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const messages = yield* agent.session.listMessages;
              const now = yield* DateTime.now;
              const threadId = snapshotInput.providerThread.appThreadId ?? input.threadId;
              const projectedMessages: Array<OrchestrationV2ConversationMessage> = messages.flatMap(
                (message) => {
                  const text = textFromAgentMessage(message);
                  if (text.length === 0) {
                    return [];
                  }
                  return [
                    {
                      createdBy: message.type === "user" ? "user" : "agent",
                      creationSource: "provider",
                      id: idAllocator.derive.messageFromProviderItem({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        nativeItemId: message.uuid,
                      }),
                      threadId,
                      runId: null,
                      nodeId: null,
                      role: message.type,
                      text,
                      attachments: [],
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ];
                },
              );
              return {
                providerThread: {
                  ...snapshotInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle" as const,
                  updatedAt: now,
                },
                providerTurns: [],
                messages: projectedMessages,
                runtimeRequests: [],
                providerPayload: {
                  agentId: requestedAgentId,
                  messages,
                },
              };
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause: "Cursor Agent SDK does not expose conversation rollback.",
              }),
            ),
          forkThread: (forkInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause: "Cursor Agent SDK does not expose native agent forks.",
              }),
            ),
        };
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

export type CursorAdapterV2DriverEnv =
  | CursorAgentSdk.CursorAgentSdkRunner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const CursorAdapterV2Driver: ProviderAdapterDriver<
  CursorSettings,
  CursorAdapterV2DriverEnv
> = {
  driverKind: CURSOR_DRIVER_KIND,
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => DEFAULT_CURSOR_SETTINGS,
  create: Effect.fn("CursorAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CursorSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      return yield* makeCursorAdapterV2({
        instanceId: input.instanceId,
        settings: {
          ...input.config,
          enabled: input.enabled,
        },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CURSOR_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Cursor Agent SDK adapter.",
              cause,
            }),
        ),
      ),
  ),
};
