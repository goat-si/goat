import {
  resolveOpenCodeRootStop,
  runOpenCodeStop,
  STOP_CONFIRM_TIMEOUT_MS,
  type OpenCodeStopDeadline,
} from "./sessionStop.ts";
import { subagentResultPreview, TRACKING_LOST } from "./subagentResult.ts";
import { childCallsToStop, makeDetachedChildOutcomes } from "./detachedChildOutcomes.ts";
import {
  topLevelRequestOwner,
  type ActiveOpenCodeTurn,
  type OpenCodeRequestOwner,
  type OpenCodeSubagentContext,
  type OpenCodeThreadState,
  type PendingOpenCodeRequest,
  type TerminalTurnStatus,
} from "./adapterState.ts";
import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  isOpenCodePromptRejected,
  reconcileOpenCodePromptAdmissionStatus,
} from "./promptAdmission.ts";
export {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  reconcileOpenCodePromptAdmissionStatus,
} from "./promptAdmission.ts";
import { makeCurrentLaunchEnvironment } from "./launchEnvironment.ts";
import { settingsSecretLiteral } from "@goat/contracts";
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  openCodeOwnsSubagentDeny,
  openCodeInstalledPermission,
  openCodePermissionRules,
  openCodePermissionRulesEqual,
  openCodeParentPermissionBases,
  openCodePermissionRequestKind,
} from "./permissionRules.ts";
import {
  installResumedOpenCodePermission,
  refreshOpenCodeChildPermissions,
  resolveOpenCodeChildPermission,
  retainOpenCodePreviousPermissionBase,
  type OpenCodePermissionUpdate,
  syncOpenCodeSubagentDeny,
} from "./permissionSync.ts";
import { recordString, recordValue } from "./records.ts";
import { openCodeLiveWork } from "./liveWork.ts";
export {
  openCodeChildPermissionRules,
  openCodePermissionRequestKind,
  openCodePermissionRules,
} from "./permissionRules.ts";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@goat/provider-core/server/mcpToolPresentation";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { goatOrchestrationSystemPrompt } from "@goat/provider-core/server/orchestrationInstructions";
import { buildSessionRuntimeInstructions } from "./screenInstructions.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { dateTimeFromEpoch, toolCompletedAt, toolInput, toolStartedAt } from "./toolPartTimes.ts";
import {
  readOpenCodeCatalogModel,
  resolveOpenCodeVariant,
  type OpenCodeVariantCache,
} from "./openCodeVariant.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { ProviderContinuationRequests } from "@goat/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@goat/provider-core/server/selectionTransition";
import { providerMessageTextWithAttachmentPaths } from "@goat/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@goat/provider-core/server/adapterDriver";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@goat/provider-core/server/subagentProjection";
import {
  toolModel,
  taskSessionId,
  openCodeToolStatus,
  openCodeToolOutputWithImages,
  openCodeToolStateResult,
  openCodeToolTitle as toolTitle,
  openCodeToolTurnItem,
} from "./toolItems.ts";
import { goatRemoteMcpConfig } from "./goatMcpConfig.ts";
import {
  accumulateOpenCodeStepUsage,
  makeOpenCodeTurnTokenUsageAccumulator,
  openCodeContextUsage,
  type OpenCodeStepUsage,
} from "./turnUsage.ts";

import {
  isOpenCodeNotFound,
  makeOpenCodeProtocolLogger,
  openCodeErrorMessage,
  OpenCodeProviderCapabilitiesV2,
  OPENCODE_PROVIDER,
  sdkResponseForRawLog,
  unwrapData,
} from "./adapterProtocol.ts";
import {
  makeOpenCodeBackgroundTurns,
  openCodeBufferedContinuation,
  openCodeWorkSessionId,
} from "./backgroundTurns.ts";

export {
  makeOpenCodeProtocolLogger,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
  type OpenCodeProtocolLogEvent,
} from "./adapterProtocol.ts";
export const OPENCODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE_PROVIDER);
const MAX_DETACHED_LAUNCHES = 128;
const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({});

const makeOpenCodeMessageId = Effect.fnUntraced(function* (
  clock: Ref.Ref<{ readonly epochMillis: number; readonly counter: number }>,
) {
  const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
  const counter = yield* Ref.modify(clock, (previous) => {
    const next = previous.epochMillis === epochMillis ? previous.counter + 1 : 1;
    return [next, { epochMillis, counter: next }] as const;
  });
  const encodedTime = BigInt.asUintN(48, BigInt(epochMillis) * 0x1000n + BigInt(counter))
    .toString(16)
    .padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = (yield* Effect.forEach(Array.from({ length: 28 }), () =>
    Random.nextIntBetween(0, alphabet.length - 1),
  ))
    .map((index) => alphabet[index])
    .join("");
  return `msg_${encodedTime}${random}`;
});

export interface OpenCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly currentEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
}

function protocolError(
  detail: string,
  payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: OPENCODE_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === null || nativeId === undefined) {
    throw protocolError(`Provider thread ${providerThread.id} has no OpenCode session id`);
  }
  return nativeId;
}

/** Boundaries are exclusive: use the next user message, or omit at head to retain the selected turn. */
export function openCodeBoundaryAfterProviderTurn(
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  selectedProviderTurnId: OrchestrationV2ProviderTurn["id"],
): string | undefined {
  const selected = providerTurns.find((turn) => turn.id === selectedProviderTurnId);
  if (selected === undefined) return undefined;
  return providerTurns
    .filter((turn) => turn.ordinal > selected.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((turn) => turn.nativeTurnRef?.nativeId)
    .find((nativeId): nativeId is string => nativeId !== null && nativeId !== undefined);
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly nativeSession: OpenCodeSession;
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const createdAt = dateTimeFromEpoch(input.nativeSession.time.created, input.now);
  return {
    id: input.idAllocator.derive.providerThread({
      driver: OPENCODE_PROVIDER,
      nativeThreadId: input.nativeSession.id,
    }),
    driver: OPENCODE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: OPENCODE_PROVIDER,
      nativeId: input.nativeSession.id,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt,
    updatedAt: dateTimeFromEpoch(input.nativeSession.time.updated, input.now),
  };
}

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return {
    driver: OPENCODE_PROVIDER,
    nativeId,
    strength,
  } satisfies OrchestrationV2ProviderRef;
}

function terminalStatusForError(
  event: Extract<OpenCodeEvent, { type: "session.error" }>,
  turn: ActiveOpenCodeTurn,
): TerminalTurnStatus {
  return turn.interrupted || isMessageAbortedError(event) ? "interrupted" : "failed";
}

function isMessageAbortedError(event: Extract<OpenCodeEvent, { type: "session.error" }>): boolean {
  return event.properties.error?.name === "MessageAbortedError";
}

export const makeOpenCodeAdapterV2 = Effect.fn("makeOpenCodeAdapterV2")(function* (
  options: OpenCodeAdapterV2Options,
) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const continuationRequests = yield* ProviderContinuationRequests;
  const messageIdClock = yield* Ref.make({ epochMillis: -1, counter: 0 });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OPENCODE_PROVIDER,
    getCapabilities: Effect.fn("OpencodeAdapter.getCapabilities")(function () {
      return Effect.succeed(OpenCodeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("OpencodeAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("OpenCodeAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const scope = yield* Effect.scope;
        const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
        const connection = yield* runtime.connectToOpenCodeServer({
          binaryPath: options.settings.binaryPath,
          directory: cwd,
          serverUrl: options.settings.serverUrl,
          ...(options.settings.serverPassword
            ? { serverPassword: settingsSecretLiteral(options.settings.serverPassword) }
            : {}),
          environment: yield* options.currentEnvironment ?? Effect.succeed(options.environment),
        });
        const client = runtime.createOpenCodeSdkClient({
          baseUrl: connection.url,
          directory: cwd,
          ...(connection.serverPassword !== undefined
            ? { serverPassword: connection.serverPassword }
            : {}),
        });
        const mcpSession = yield* mcpSessions.read(input.threadId);
        const hasGoatMcp = mcpSession !== undefined && !connection.external;
        let installedMcpSession = hasGoatMcp ? mcpSession : undefined;
        const orchestrationSystemPrompt = goatOrchestrationSystemPrompt(
          hasGoatMcp,
          mcpSession?.browserToolsAvailable,
        );
        if (hasGoatMcp) {
          yield* OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
            client.mcp.add({
              name: "goat",
              config: goatRemoteMcpConfig(mcpSession.endpoint, mcpSession.authorizationHeader),
            }),
          );
        }
        // Computer use is an addition: a server that cannot add it still runs
        // the session, and the prompt only advertises it once it is attached.
        // Each turn reconciles it, so enabling or disabling reaches this
        // session on its next turn.
        let installedCuaKey = "";
        const syncCuaDriver = Effect.fn("OpenCodeAdapterV2.syncCuaDriver")(function* (
          threadId: ThreadId,
        ) {
          if (!hasGoatMcp) return false;
          const cuaDriver = (yield* mcpSessions.read(threadId))?.cuaDriver;
          const wanted = McpProviderSession.cuaDriverKey(cuaDriver);
          if (wanted === installedCuaKey) return wanted !== "";
          if (cuaDriver === undefined) {
            yield* OpenCodeRuntime.runOpenCodeSdk("mcp.disconnect", () =>
              client.mcp.disconnect({ name: McpProviderSession.CUA_MCP_SERVER_NAME }),
            ).pipe(Effect.ignore({ log: true }));
            installedCuaKey = "";
            return false;
          }
          const added = yield* OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
            client.mcp.add({
              name: McpProviderSession.CUA_MCP_SERVER_NAME,
              config: McpProviderSession.cuaOpenCodeMcpConfig(cuaDriver),
            }),
          ).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not add Cua Driver to OpenCode.", cause).pipe(
                Effect.as(false),
              ),
            ),
          );
          installedCuaKey = added ? wanted : "";
          return added;
        });
        const now = yield* DateTime.now;
        let sessionEntity: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: OPENCODE_PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities: OpenCodeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        let nativeStreamFailure: OrchestrationV2ProviderFailure | null = null;
        const threads = new Map<string, OpenCodeThreadState>();
        const variantCache: OpenCodeVariantCache = new Map();
        const commandReceipts = new Map<string, Deferred.Deferred<void>>();
        const commandControllers = new Map<string, Set<AbortController>>();
        const pendingRequests = new Map<string, PendingOpenCodeRequest>();
        const pendingRequestsByNativeId = new Map<string, PendingOpenCodeRequest>();
        const subagentsByNativeItemId = new Map<string, OpenCodeSubagentContext>();
        const subagentsByChildSessionId = new Map<string, OpenCodeSubagentContext>();
        const relatedSessionOwners = new Map<string, OpenCodeThreadState>();
        const childOutcomes = makeDetachedChildOutcomes(
          (id) => subagentsByChildSessionId.get(id)?.parentState ?? relatedSessionOwners.get(id),
        );
        const busySessionIds = new Set<string>();
        const launches = new Set<OpenCodeSubagentContext>();
        // Remember settled requests across routing retries to prevent resurrection; only recent IDs matter.
        const settledNativeRequestIds = new Set<string>();
        const pendingChildRequestRoutes = new Set<string>();
        const rememberSettledRequest = (nativeRequestId: string) => {
          if (settledNativeRequestIds.size >= 2_048) settledNativeRequestIds.clear();
          settledNativeRequestIds.add(nativeRequestId);
        };
        // @effect-diagnostics-next-line abortControllerInEffect:off - Session closure aborts this stream independently of the creation fiber.
        const abortController = new AbortController();
        let closing = false;
        let hasConnected = false;
        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const logProtocolEvent = makeOpenCodeProtocolLogger({
          nativeEventLogger: options.nativeEventLogger,
          idAllocator,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          threadId: input.threadId,
        });

        const sdkCall = <A>(
          method: string,
          payload: unknown,
          call: (signal: AbortSignal) => Promise<A>,
        ): Effect.Effect<A, OpenCodeRuntime.OpenCodeRuntimeError> =>
          logProtocolEvent({
            direction: "outgoing",
            messageKind: "request",
            method,
            payload,
          }).pipe(
            Effect.andThen(OpenCodeRuntime.runOpenCodeSdk(method, call)),
            Effect.tap((response) =>
              logProtocolEvent({
                direction: "incoming",
                messageKind: "response",
                method,
                payload: sdkResponseForRawLog(response),
              }),
            ),
          );

        const abortDescendants = Effect.fn("OpencodeAdapter.abortDescendants")(function* (
          rootId: string,
        ) {
          const visited = new Set([rootId]);
          const semaphore = Semaphore.makeUnsafe(8);
          const visit = Effect.fn("OpencodeAdapter.visit")(function* (
            sessionId: string,
            abort: boolean,
          ): Effect.fn.Return<OpenCodeRuntime.OpenCodeRuntimeError | undefined> {
            const abortResult = abort
              ? yield* sdkCall("session.abort", { sessionID: sessionId }, (signal) =>
                  client.session.abort({ sessionID: sessionId }, { signal }),
                ).pipe(
                  semaphore.withPermit,
                  Effect.catchIf(isOpenCodeNotFound, () => Effect.void),
                  Effect.result,
                )
              : undefined;
            const childrenResult = yield* sdkCall(
              "session.children",
              { sessionID: sessionId },
              (signal) => client.session.children({ sessionID: sessionId }, { signal }),
            ).pipe(
              semaphore.withPermit,
              Effect.catchIf(isOpenCodeNotFound, () => Effect.void),
              Effect.result,
            );
            const firstFailure = abortResult?._tag === "Failure" ? abortResult.failure : undefined;
            if (childrenResult._tag === "Failure") return firstFailure ?? childrenResult.failure;
            const fresh = (childrenResult.success?.data ?? []).filter((child) => {
              if (visited.has(child.id)) return false;
              visited.add(child.id);
              return true;
            });
            const failures = yield* Effect.forEach(fresh, (child) => visit(child.id, true), {
              concurrency: 8,
            });
            return firstFailure ?? failures.find((failure) => failure !== undefined);
          });
          const failure = yield* visit(rootId, false);
          if (failure) return yield* failure;
        }, Effect.timeout("15 seconds"));

        const updateProviderSession =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (
            status: OrchestrationV2ProviderSession["status"],
            lastError: string | null = sessionEntity.lastError,
          ) {
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
            yield* emitProviderEvent({
              type: "provider_session.updated",
              driver: OPENCODE_PROVIDER,
              providerSession: sessionEntity,
            });
          });

        const updateProviderThread =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (
            state: OpenCodeThreadState,
            patch: Partial<OrchestrationV2ProviderThread>,
          ) {
            const updatedAt = yield* DateTime.now;
            state.providerThread = { ...state.providerThread, ...patch, updatedAt };
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: OPENCODE_PROVIDER,
              providerThread: state.providerThread,
            });
          });

        const itemOrdinal = (turn: ActiveOpenCodeTurn, nativeItemId: string): number => {
          const existing = turn.itemOrdinals.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = turn.nextItemOrdinal++;
          turn.itemOrdinals.set(nativeItemId, ordinal);
          return ordinal;
        };

        const emitProviderTurn = (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
          contextWindow?: number,
        ) => {
          const providerTurn: OrchestrationV2ProviderTurn = {
            ...turn.providerTurn,
            nativeTurnRef:
              turn.nativeUserMessageId === null
                ? turn.providerTurn.nativeTurnRef
                : providerRef(turn.nativeUserMessageId, "weak"),
            status,
            completedAt,
            ...(completedAt === null
              ? {}
              : {
                  ...openCodeContextUsage(turn.usage.lastStep, contextWindow, completedAt),
                  turnTokenUsage:
                    turn.usage.partIds.size === 0
                      ? {
                          usageScope: "main_agent" as const,
                          usageStatus: "unavailable" as const,
                          hasSubagents: turn.usage.hasSubagents,
                        }
                      : {
                          usageScope: "main_agent" as const,
                          usageStatus:
                            status === "completed" &&
                            turn.usage.complete &&
                            turn.usage.unresolvedStepsByMessageId.size === 0
                              ? ("complete" as const)
                              : ("partial" as const),
                          inputTokens: turn.usage.inputTokens,
                          cachedInputTokens: turn.usage.cachedInputTokens,
                          cacheCreationTokens: turn.usage.cacheCreationTokens,
                          outputTokens: turn.usage.outputTokens,
                          reasoningTokens: turn.usage.reasoningTokens,
                          hasSubagents: turn.usage.hasSubagents,
                        },
                }),
          };
          Object.assign(turn.providerTurn, providerTurn);
          state.providerTurns.set(String(providerTurn.id), providerTurn);
          return emitProviderEvent({
            type: "provider_turn.updated",
            driver: OPENCODE_PROVIDER,
            threadId: turn.threadId,
            providerTurn,
          });
        };

        const emitTextPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: Extract<OpenCodePart, { type: "text" | "reasoning" }>,
          forceCompleted = false,
        ) {
          if (part.type === "text" && (part.ignored === true || part.synthetic === true)) return;
          if (part.text.length === 0) return;
          const emittedAt = yield* DateTime.now;
          const isCompleted = forceCompleted || part.time?.end !== undefined;
          const startedAt = dateTimeFromEpoch(part.time?.start, emittedAt);
          const completedAt = isCompleted ? dateTimeFromEpoch(part.time?.end, emittedAt) : null;
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const ordinal = itemOrdinal(turn, part.id);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: part.type === "text" ? "assistant_message" : "reasoning",
              status: isCompleted ? "completed" : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });
          if (part.type === "text") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: OPENCODE_PROVIDER,
              nativeItemId: part.id,
            });
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              role: "assistant",
              text: part.text,
              attachments: [],
              streaming: !isCompleted,
              createdAt: startedAt,
              updatedAt: emittedAt,
            };
            yield* emitProviderEvent({
              type: "message.updated",
              driver: OPENCODE_PROVIDER,
              message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: OPENCODE_PROVIDER,
              turnItem: {
                id: turnItemId,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId,
                providerThreadId: state.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef,
                parentItemId: null,
                ordinal,
                status: isCompleted ? "completed" : "running",
                title: null,
                startedAt,
                completedAt,
                updatedAt: emittedAt,
                type: "assistant_message",
                messageId,
                text: part.text,
                streaming: !isCompleted,
              },
            });
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: isCompleted ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt: emittedAt,
              type: "reasoning",
              text: part.text,
              streaming: !isCompleted,
            },
          });
        });

        // A child turn's ordinal never exceeds its user message's position in the session, and that
        // position survives restarts, so it stays above every ordinal allocated before.
        const storedUserMessagePosition = Effect.fnUntraced(function* (
          childSessionId: string,
          messageId: string,
        ) {
          const response = yield* sdkCall("session.messages", { sessionID: childSessionId }, () =>
            client.session.messages({ sessionID: childSessionId }),
          );
          const userMessageIds = unwrapData("session.messages", response).flatMap((entry) =>
            entry.info.role === "user" ? [entry.info.id] : [],
          );
          const index = userMessageIds.indexOf(messageId);
          return (index === -1 ? userMessageIds.length : index) + 1;
        });

        const emitSubagentStatus = Effect.fnUntraced(function* (
          context: OpenCodeSubagentContext,
          status: ReturnType<typeof openCodeToolStatus>,
          completedAt: DateTime.Utc | null,
          now: DateTime.Utc,
        ) {
          const { parentState: state, parentTurn: turn, nodeId, prompt, title } = context;
          const nativeItemRef = providerRef(context.nativeItemId);
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: context.nativeItemId,
          });
          const subagentStatus: OrchestrationV2Subagent["status"] = status.item;
          const subagent: OrchestrationV2Subagent = {
            id: nodeId,
            threadId: turn.threadId,
            runId: turn.runId,
            parentNodeId: turn.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OPENCODE_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: context.childProviderThreadId,
            childThreadId: context.childThreadId,
            nativeTaskRef: nativeItemRef,
            prompt,
            title,
            model: context.model,
            status: subagentStatus,
            result: context.result,
            startedAt: context.startedAt,
            completedAt,
            updatedAt: now,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "subagent",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.childProviderThreadId ?? state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: OPENCODE_PROVIDER,
            subagent,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: itemOrdinal(turn, context.nativeItemId),
              status: status.item,
              title,
              startedAt: context.startedAt,
              completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: nodeId,
              origin: "provider_native",
              driver: OPENCODE_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: context.childThreadId,
              prompt,
              result: context.result,
            },
          });
        });

        const settleLaunch = Effect.fnUntraced(function* (
          context: OpenCodeSubagentContext,
          outcome: TerminalTurnStatus,
        ) {
          launches.delete(context);
          context.launchOutcome = outcome;
          if (context.result === TRACKING_LOST) context.result = null;
          const now = yield* DateTime.now;
          yield* emitSubagentStatus(context, { node: outcome, item: outcome }, now, now);
        });

        const loseLaunch = Effect.fnUntraced(function* (context: OpenCodeSubagentContext) {
          launches.delete(context);
          context.result = TRACKING_LOST;
          yield* emitSubagentStatus(
            context,
            { node: "idle", item: "idle" },
            null,
            yield* DateTime.now,
          );
        });

        const emitSubagent = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: ToolPart,
        ) {
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          turn.usage.hasSubagents = true;
          const input = toolInput(part);
          const prompt = recordString(input, "prompt") ?? "";
          const title = toolTitle(part) ?? recordString(input, "description") ?? null;
          let context = subagentsByNativeItemId.get(part.id);
          if (context === undefined) {
            context = {
              nativeItemId: part.id,
              nodeId,
              parentState: state,
              parentTurn: turn,
              prompt,
              title,
              startedAt: toolStartedAt(part, now),
              childSessionId: null,
              childThreadId: null,
              childProviderThreadId: null,
              model: null,
              result: null,
            };
            subagentsByNativeItemId.set(part.id, context);
          }
          context.model = toolModel(part) ?? context.model;
          const childSessionId = taskSessionId(part);
          if (childSessionId !== null && context.childSessionId === null) {
            context.childSessionId = childSessionId;
            context.childThreadId = idAllocator.derive.subagentThread({
              driver: OPENCODE_PROVIDER,
              nativeThreadId: childSessionId,
            });
            context.childProviderThreadId = idAllocator.derive.providerThread({
              driver: OPENCODE_PROVIDER,
              nativeThreadId: childSessionId,
            });
            context.childExecution = childOutcomes.claim(
              childSessionId,
              subagentsByChildSessionId.get(childSessionId)?.childExecution,
              recordString(input, "task_id") === childSessionId,
              busySessionIds.has(childSessionId),
            );
            subagentsByChildSessionId.set(childSessionId, context);
            relatedSessionOwners.set(childSessionId, state);
            const childModelSelection: ModelSelection = {
              instanceId: options.instanceId,
              model: context.model ?? turn.modelSelection.model,
            };
            const childThread = makeSubagentChildThread({
              parentThread: turn.appThread,
              childThreadId: context.childThreadId,
              parentNodeId: nodeId,
              activeProviderThreadId: context.childProviderThreadId,
              providerInstanceId: options.instanceId,
              modelSelection: childModelSelection,
              title: subagentThreadTitle({
                parentTitle: turn.appThread.title,
                title,
                prompt,
                ordinal: itemOrdinal(turn, part.id),
              }),
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            const childProviderThread: OrchestrationV2ProviderThread = {
              id: context.childProviderThreadId,
              driver: OPENCODE_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: inputProviderSessionId,
              appThreadId: context.childThreadId,
              ownerNodeId: nodeId,
              nativeThreadRef: providerRef(childSessionId),
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            };
            const childSessionResponse = yield* sdkCall(
              "session.get",
              { sessionID: childSessionId },
              () => client.session.get({ sessionID: childSessionId }),
            );
            const nativeChildSession = unwrapData("session.get", childSessionResponse);
            const childPermission = yield* resolveOpenCodeChildPermission(
              nativeChildSession,
              turn.runtimePolicy,
              state.subagentsDenied,
              openCodeParentPermissionBases(state),
            );
            const installed = yield* retainOpenCodePreviousPermissionBase(
              nativeChildSession,
              childPermission,
            );
            yield* updatePermission(childSessionId, {
              permission: installed.permission,
              metadata: installed.metadata,
            });
            // A Task call with task_id resumes the child, whose earlier turns already hold ordinals.
            const knownChild = threads.get(childSessionId);
            const resumedChild = knownChild?.parentSubagent == null ? undefined : knownChild;
            const nextChildTurnOrdinal =
              resumedChild === undefined
                ? recordString(input, "task_id") === childSessionId
                  ? null
                  : 1
                : resumedChild.nextChildTurnOrdinal;
            threads.set(childSessionId, {
              nativeSessionId: childSessionId,
              providerThread: childProviderThread,
              appThread: childThread,
              activeTurn: null,
              providerTurns: new Map(),
              runtimeRequests: new Map(),
              messageRoles: resumedChild?.messageRoles ?? new Map(),
              userMessageIds: resumedChild?.userMessageIds ?? [],
              parentSubagent: context,
              nextChildTurnOrdinal,
              nextAdmissionGeneration: 1,
              ...installed,
            });
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: OPENCODE_PROVIDER,
              appThread: childThread,
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: OPENCODE_PROVIDER,
              providerThread: childProviderThread,
            });
          }
          const childId = context.childSessionId;
          const detached =
            part.state.status === "completed" &&
            childId !== null &&
            recordValue(part.state.metadata, "background") === true;
          if (detached) context.detached = true;
          context.prompt = detached ? subagentResultPreview(prompt) : prompt;
          context.title = detached && title !== null ? subagentResultPreview(title) : title;
          if (part.state.status === "completed") {
            context.result = detached
              ? subagentResultPreview(part.state.output)
              : part.state.output;
          }
          const outcome = context.launchOutcome ?? context.childExecution?.outcome;
          const launched =
            detached &&
            outcome === undefined &&
            (busySessionIds.has(childId) || childOutcomes.isUnstarted(childId));
          if (launched) {
            if (!launches.has(context) && launches.size >= MAX_DETACHED_LAUNCHES) {
              const oldest = launches.values().next();
              if (!oldest.done) yield* loseLaunch(oldest.value);
            }
            launches.add(context);
            return yield* emitSubagentStatus(
              context,
              { node: "running", item: "running" },
              null,
              now,
            );
          }
          if (detached && outcome !== undefined) return yield* settleLaunch(context, outcome);
          launches.delete(context);
          if (detached) return yield* loseLaunch(context);
          yield* emitSubagentStatus(
            context,
            openCodeToolStatus(part),
            toolCompletedAt(part, now),
            now,
          );
        });

        const stopDetachedChildren = Effect.fnUntraced(function* (sessionId: string) {
          for (const context of childCallsToStop(subagentsByNativeItemId.values(), sessionId)) {
            if (context.detached) yield* settleLaunch(context, "interrupted");
            else childOutcomes.stoppedBeforeLaunch(context.childExecution);
          }
        });

        const concludeChild = Effect.fnUntraced(function* (
          sessionId: string,
          status: TerminalTurnStatus,
          finalized?: OpenCodeSubagentContext,
        ) {
          const context = finalized ?? subagentsByChildSessionId.get(sessionId);
          if (
            context?.launchOutcome !== undefined &&
            context.childExecution?.pendingResume === undefined
          )
            return;
          const outcome = childOutcomes.observe(
            sessionId,
            status,
            context?.childExecution,
            finalized !== undefined,
          );
          if (outcome !== undefined && context?.detached === true)
            yield* settleLaunch(context, outcome);
        });

        const emitToolPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: ToolPart,
        ) {
          const normalizedTool = part.tool.toLowerCase();
          if (normalizedTool === "task") {
            yield* emitSubagent(state, turn, part);
            return;
          }
          if (normalizedTool === "question") return;
          const now = yield* DateTime.now;
          const status = openCodeToolStatus(part);
          const startedAt = toolStartedAt(part, now);
          const completedAt = toolCompletedAt(part, now);
          const nativeItemRef = providerRef(part.id);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.id,
          });
          const base = {
            id: turnItemId,
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: itemOrdinal(turn, part.id),
            status: status.item,
            title: toolTitle(part),
            startedAt,
            completedAt,
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
          const input = toolInput(part);
          const { output, fileUrls } = openCodeToolStateResult(part.state);
          const isNativeTool = part.tool === "code_search" || part.tool === "apply_patch";
          if (!isNativeTool && part.tool.includes("_") && turn.mcpServerNames === undefined) {
            const serverNames = yield* OpenCodeRuntime.runOpenCodeSdk("mcp.status", (signal) =>
              client.mcp.status(undefined, { signal, throwOnError: true }),
            ).pipe(
              Effect.timeout("1 second"),
              Effect.map((response) => Object.keys(response.data ?? {})),
              Effect.catch(() => Effect.void),
            );
            if (serverNames !== undefined) turn.mcpServerNames = serverNames;
          }
          const matchingServers = turn.mcpServerNames?.filter(
            (name) =>
              !isNativeTool && part.tool.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`),
          );
          const serverName = matchingServers?.length === 1 ? matchingServers[0] : undefined;
          const mcpOutput = openCodeToolOutputWithImages(output, fileUrls);
          const presentation =
            serverName === undefined
              ? {}
              : mcpToolPresentation({
                  serverName,
                  toolName: part.tool.slice(serverName.replace(/[^a-zA-Z0-9_-]/g, "_").length + 1),
                  title: toolTitle(part) === part.tool ? undefined : toolTitle(part),
                });
          const turnItem: OrchestrationV2TurnItem = matchingServers?.length
            ? {
                ...base,
                type: "dynamic_tool",
                ...presentation,
                toolName: part.tool,
                input,
                ...(mcpOutput === undefined ? {} : { output: mcpOutput }),
              }
            : openCodeToolTurnItem(base, {
                name: part.tool,
                input,
                output,
                fileUrls,
                completedMetadata:
                  part.state.status === "completed" ? part.state.metadata : undefined,
              });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem,
          });
        });

        const emitTodo = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          todos: ReadonlyArray<OpenCodeTodo>,
        ) {
          const now = yield* DateTime.now;
          if (turn.planId === null) {
            turn.planId = yield* idAllocator.allocate.plan({
              threadId: turn.threadId,
              ...(turn.runId === null ? {} : { runId: turn.runId }),
              driver: OPENCODE_PROVIDER,
            });
          }
          const planId = turn.planId;
          const nativeItemId = `${state.nativeSessionId}:todo:${turn.providerTurnId}`;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId,
          });
          // A cancelled todo is not outstanding work, and plan steps have no
          // cancelled status, so drop it rather than show it as pending.
          const steps: Array<OrchestrationV2PlanStep> = todos.flatMap((todo, index) =>
            todo.status === "cancelled"
              ? []
              : [
                  {
                    id: `${nativeItemId}:${index + 1}`,
                    text: todo.content.trim() || `Todo ${index + 1}`,
                    status:
                      todo.status === "completed"
                        ? "completed"
                        : todo.status === "in_progress"
                          ? "running"
                          : "pending",
                  },
                ],
          );
          const completed = todos.length > 0 && steps.every((step) => step.status === "completed");
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "todo_list",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: OPENCODE_PROVIDER,
            plan: {
              id: planId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              status: completed ? "completed" : "active",
              kind: "todo_list",
              steps,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              parentItemId: null,
              ordinal: itemOrdinal(turn, nativeItemId),
              status: completed ? "completed" : "running",
              title: "Todo list",
              startedAt: turn.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps,
            },
          });
        });

        const requestQuestions = (request: QuestionRequest) =>
          request.questions.map((question, index) => ({
            id: OpenCodeRuntime.openCodeQuestionId(index, question),
            header: question.header.trim() || `Question ${index + 1}`,
            question: question.question.trim() || question.header.trim() || `Question ${index + 1}`,
            ...(question.multiple === undefined ? {} : { multiSelect: question.multiple }),
            ...(question.custom === undefined ? {} : { allowCustomAnswer: question.custom }),
            options: question.options.map((option) => ({
              label: option.label.trim() || "Option",
              description: option.description.trim() || option.label.trim() || "Option",
            })),
          }));

        const runtimeRequestTurnItem = (
          pending: PendingOpenCodeRequest,
          status: OrchestrationV2TurnItem["status"],
          completedAt: DateTime.Utc | null,
          updatedAt: DateTime.Utc,
        ): OrchestrationV2TurnItem => {
          const base = {
            id: pending.turnItemId,
            threadId: pending.turn.threadId,
            runId: pending.turn.runId,
            nodeId: pending.nodeId,
            providerThreadId: pending.state.providerThread.id,
            providerTurnId: pending.turn.providerTurnId,
            nativeItemRef: providerRef(pending.nativeRequestId),
            parentItemId: null,
            ordinal: itemOrdinal(pending.turn, pending.nativeRequestId),
            status,
            startedAt: pending.createdAt,
            completedAt,
            updatedAt,
          };
          if (pending.question !== undefined) {
            return {
              ...base,
              title: "User input",
              type: "user_input_request",
              requestId: pending.requestId,
              questions: requestQuestions(pending.question),
            };
          }
          const permission = pending.permission;
          if (permission === undefined) {
            throw protocolError(`OpenCode request ${pending.requestId} has no native payload`);
          }
          return {
            ...base,
            title: permission.permission,
            type: "approval_request",
            requestId: pending.requestId,
            requestKind: pending.requestKind === "user_input" ? "command" : pending.requestKind,
            prompt:
              permission.patterns.length === 0
                ? permission.permission
                : permission.patterns.join("\n"),
          };
        };

        const emitRuntimeRequest = Effect.fnUntraced(function* (
          owner: OpenCodeRequestOwner,
          nativeRequestId: string,
          request:
            | { readonly type: "permission"; readonly value: PermissionRequest }
            | { readonly type: "question"; readonly value: QuestionRequest },
        ) {
          if (pendingRequestsByNativeId.has(nativeRequestId)) return;
          const { state, turn, subagent } = owner;
          const now = yield* DateTime.now;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: OPENCODE_PROVIDER,
            providerTurnId: turn.providerTurnId,
            nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const turnItemId = idAllocator.derive.approvalTurnItem({ requestId });
          const permissionToolName =
            request.type === "permission" && request.value.tool !== undefined
              ? threads
                  .get(request.value.sessionID)
                  ?.activeTurn?.toolNamesByCallId.get(request.value.tool.callID)
              : undefined;
          const permissionRequestKind =
            request.type === "permission"
              ? openCodePermissionRequestKind(request.value.permission, permissionToolName)
              : undefined;
          const requestKind: OrchestrationV2RuntimeRequest["kind"] =
            permissionRequestKind ?? "user_input";
          const pending: PendingOpenCodeRequest = {
            requestId,
            nativeRequestId,
            nativeSessionId: request.value.sessionID,
            turn,
            state,
            nodeId,
            parentNodeId: subagent?.nodeId ?? turn.rootNodeId,
            turnItemId,
            requestKind,
            createdAt: now,
            ...(request.type === "permission"
              ? { permission: request.value }
              : { question: request.value }),
          };
          pendingRequests.set(String(requestId), pending);
          pendingRequestsByNativeId.set(nativeRequestId, pending);
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurnId,
            nativeRequestRef: providerRef(nativeRequestId),
            kind: requestKind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: inputProviderSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          state.runtimeRequests.set(String(requestId), runtimeRequest);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: pending.parentNodeId,
              rootNodeId: turn.rootNodeId,
              kind: request.type === "question" ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeRequestId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: runtimeRequestTurnItem(pending, "waiting", null, now),
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver: OPENCODE_PROVIDER,
            threadId: turn.threadId,
            runtimeRequest,
          });
          yield* updateProviderSession("waiting", null);
        });

        const resolveRuntimeRequest = Effect.fnUntraced(function* (
          nativeRequestId: string,
          status: "resolved" | "cancelled",
        ) {
          const pending = pendingRequestsByNativeId.get(nativeRequestId);
          if (pending === undefined) return;
          const now = yield* DateTime.now;
          const current = pending.state.runtimeRequests.get(String(pending.requestId));
          if (current !== undefined) {
            const resolved: OrchestrationV2RuntimeRequest = {
              ...current,
              status,
              resolvedAt: now,
            };
            pending.state.runtimeRequests.set(String(pending.requestId), resolved);
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: OPENCODE_PROVIDER,
              threadId: pending.turn.threadId,
              runtimeRequest: resolved,
            });
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: pending.nodeId,
              threadId: pending.turn.threadId,
              runId: pending.turn.runId,
              parentNodeId: pending.parentNodeId,
              rootNodeId: pending.turn.rootNodeId,
              kind: pending.question === undefined ? "approval_request" : "user_input_request",
              status: status === "resolved" ? "completed" : "cancelled",
              countsForRun: false,
              providerThreadId: pending.state.providerThread.id,
              providerTurnId: pending.turn.providerTurnId,
              nativeItemRef: providerRef(nativeRequestId),
              runtimeRequestId: pending.requestId,
              checkpointScopeId: null,
              startedAt: pending.createdAt,
              completedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: runtimeRequestTurnItem(
              pending,
              status === "resolved" ? "completed" : "cancelled",
              now,
              now,
            ),
          });
          pendingRequests.delete(String(pending.requestId));
          pendingRequestsByNativeId.delete(nativeRequestId);
          const hasOtherPending = Array.from(pendingRequests.values()).some(
            (candidate) => candidate.turn.isRoot,
          );
          if (!hasOtherPending) yield* updateProviderSession("running", null);
        });

        const resolveSessionOwner = Effect.fnUntraced(function* (sessionId: string) {
          const known = threads.get(sessionId) ?? relatedSessionOwners.get(sessionId);
          if (known !== undefined) return known;
          let cursor = sessionId;
          const hops: string[] = [];
          for (let depth = 0; depth < 5; depth += 1) {
            const response = yield* sdkCall("session.get", { sessionID: cursor }, () =>
              client.session.get({ sessionID: cursor }),
            ).pipe(Effect.option);
            const info = Option.getOrUndefined(response)?.data;
            const parentId = info?.parentID;
            if (parentId === undefined) return undefined;
            hops.push(cursor);
            const owner = threads.get(parentId) ?? relatedSessionOwners.get(parentId);
            if (owner !== undefined) {
              for (const hop of hops) relatedSessionOwners.set(hop, owner);
              return owner;
            }
            cursor = parentId;
          }
          return undefined;
        });

        const routeRuntimeRequest = Effect.fnUntraced(function* (
          nativeRequestId: string,
          sessionId: string,
          request:
            | { readonly type: "permission"; readonly value: PermissionRequest }
            | { readonly type: "question"; readonly value: QuestionRequest },
        ) {
          if (pendingChildRequestRoutes.has(nativeRequestId)) return;
          const attempt = Effect.gen(function* () {
            if (
              settledNativeRequestIds.has(nativeRequestId) ||
              pendingRequestsByNativeId.has(nativeRequestId)
            ) {
              return true;
            }
            const state = yield* resolveSessionOwner(sessionId);
            const owner = state === undefined ? undefined : topLevelRequestOwner(state);
            if (owner === undefined) return false;
            yield* emitRuntimeRequest(owner, nativeRequestId, request);
            return true;
          });
          if (yield* attempt) return;
          pendingChildRequestRoutes.add(nativeRequestId);
          yield* Effect.gen(function* () {
            for (let retry = 0; retry < 5; retry += 1) {
              yield* Effect.sleep(Duration.millis(Math.min(200 * 2 ** retry, 2_000)));
              if (yield* attempt) return;
            }
          }).pipe(
            Effect.ensuring(Effect.sync(() => pendingChildRequestRoutes.delete(nativeRequestId))),
            Effect.forkIn(scope),
          );
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          status: TerminalTurnStatus,
          terminal?: {
            readonly failure?: OrchestrationV2ProviderFailure;
            readonly threadDisposition?: "reusable" | "broken";
          },
        ) {
          // Once claimed, terminal publication must finish even if the replay deadline expires.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (turn.finalized) return;
              if (!turn.isRoot && childOutcomes.isStopping(state.nativeSessionId))
                status = "interrupted";
              if (nativeStreamFailure !== null) {
                status = "failed";
                terminal = { failure: nativeStreamFailure, threadDisposition: "broken" };
              }
              let lastError = sessionEntity.lastError;
              if (status === "completed" && turn.contextOverflow !== null) {
                status = "failed";
                terminal = { failure: turn.contextOverflow };
                lastError = turn.contextOverflow.message;
              }
              turn.finalized = true;
              if (turn.priorWakeSettled !== undefined)
                yield* Deferred.succeed(turn.priorWakeSettled, undefined);
              const completedAt = yield* DateTime.now;
              for (const part of turn.parts.values()) {
                if (part.type === "text" || part.type === "reasoning") {
                  yield* emitTextPart(state, turn, part, true);
                }
              }
              for (const pending of Array.from(pendingRequests.values())) {
                if (
                  pending.turn.providerTurnId === turn.providerTurnId ||
                  pending.nativeSessionId === state.nativeSessionId
                ) {
                  yield* resolveRuntimeRequest(pending.nativeRequestId, "cancelled");
                }
              }
              const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(turn.modelSelection.model);
              let catalogModel = variantCache.get(turn.modelSelection.model.trim());
              if (status === "completed" && turn.usage.lastStep !== null && parsedModel !== null) {
                const read = yield* restore(
                  readOpenCodeCatalogModel(client, parsedModel, undefined, variantCache),
                ).pipe(Effect.exit);
                if (Exit.isSuccess(read)) catalogModel = read.value;
              }
              yield* emitProviderTurn(
                state,
                turn,
                status,
                completedAt,
                catalogModel?.contextWindow,
              );
              const threadDisposition = terminal?.threadDisposition ?? "reusable";
              yield* updateProviderThread(state, {
                status: turn.isRoot ? "active" : threadDisposition === "broken" ? "error" : "idle",
                nativeConversationHeadRef:
                  turn.nativeUserMessageId === null
                    ? state.providerThread.nativeConversationHeadRef
                    : providerRef(turn.nativeUserMessageId, "weak"),
              });
              state.activeTurn = null;
              if (!turn.isRoot) {
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: OPENCODE_PROVIDER,
                  node: {
                    id: turn.rootNodeId,
                    threadId: turn.threadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: turn.rootNodeId,
                    kind: "root_turn",
                    status,
                    countsForRun: false,
                    providerThreadId: state.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    nativeItemRef: providerRef(state.nativeSessionId),
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: turn.startedAt,
                    completedAt,
                  },
                });
                if (terminal?.threadDisposition !== "broken")
                  yield* concludeChild(state.nativeSessionId, status, turn.childCall);
                return;
              }
              const anotherTurnIsActive = Array.from(threads.values()).some(
                (candidate) => candidate.activeTurn?.isRoot === true,
              );
              yield* updateProviderSession(
                anotherTurnIsActive ? "running" : status === "failed" ? "error" : "ready",
                status === "failed" ? lastError : null,
              );
              yield* emitProviderEvent(
                status === "failed"
                  ? {
                      type: "turn.terminal",
                      driver: OPENCODE_PROVIDER,
                      providerThreadId: turn.providerThreadId,
                      providerTurnId: turn.providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      failureItemOrdinal: itemOrdinal(
                        turn,
                        `terminal-failure:${turn.providerTurnId}`,
                      ),
                      status,
                      failure:
                        terminal?.failure ??
                        makeProviderFailure({
                          message: sessionEntity.lastError ?? undefined,
                          class: "provider_error",
                        }),
                      threadDisposition,
                    }
                  : {
                      type: "turn.terminal",
                      driver: OPENCODE_PROVIDER,
                      providerThreadId: turn.providerThreadId,
                      providerTurnId: turn.providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status,
                      failure: null,
                      threadDisposition,
                    },
              );
            }),
          );
        });

        const turnIsLive = (state: OpenCodeThreadState, turn: ActiveOpenCodeTurn) =>
          state.activeTurn === turn && !turn.finalized && !turn.interrupted;

        const promptAdmissionIsCurrent = (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          generation: number,
        ) =>
          state.activeTurn === turn &&
          !turn.finalized &&
          !turn.interrupted &&
          turn.admissionPending &&
          turn.admissionGeneration === generation;

        const runPromptAdmissionReconciliation = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          generation: number,
        ) {
          while (promptAdmissionIsCurrent(state, turn, generation)) {
            const sequence = turn.admissionStatusSequence;
            const status = yield* reconcileOpenCodePromptAdmissionStatus(
              turn,
              generation,
              sdkCall(
                "session.status",
                { sessionID: state.nativeSessionId, generation },
                (signal) => client.session.status(undefined, { signal }),
              ).pipe(
                Effect.match({
                  onFailure: () => "unknown" as const,
                  onSuccess: (response) => {
                    const statuses = response.data;
                    if (statuses === undefined) return "unknown" as const;
                    const sessionStatus = statuses[state.nativeSessionId];
                    return sessionStatus === undefined || sessionStatus.type === "idle"
                      ? ("idle" as const)
                      : ("busy" as const);
                  },
                }),
              ),
            );
            if (
              state.activeTurn !== turn ||
              status === "stale" ||
              turn.finalized ||
              turn.interrupted ||
              turn.admissionGeneration !== generation
            ) {
              return;
            }
            if (sequence !== turn.admissionStatusSequence) {
              turn.admissionPending = true;
              continue;
            }
            if (status === "idle") {
              yield* finalizeTurn(state, turn, "completed");
              return;
            }
            if (status === "busy") return;
            yield* Effect.sleep("250 millis");
          }
        });

        const reconcilePromptAdmission = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
        ) {
          const generation = turn.admissionGeneration;
          if (
            !promptAdmissionIsCurrent(state, turn, generation) ||
            turn.admissionReconciliationGeneration === generation
          ) {
            return;
          }
          turn.admissionReconciliationGeneration = generation;
          yield* runPromptAdmissionReconciliation(state, turn, generation).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (turn.admissionReconciliationGeneration === generation) {
                  turn.admissionReconciliationGeneration = null;
                }
              }),
            ),
            Effect.forkIn(scope),
          );
        });

        const createChildTurn = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          message: Extract<OpenCodeMessage, { role: "user" }>,
        ) {
          if (state.appThread === null || state.parentSubagent === null) return null;
          const childCall = state.parentSubagent;
          childOutcomes.start(childCall.childExecution);
          const ordinal =
            state.nextChildTurnOrdinal ??
            (yield* storedUserMessagePosition(state.nativeSessionId, message.id));
          state.nextChildTurnOrdinal = ordinal + 1;
          const now = yield* DateTime.now;
          const startedAt = dateTimeFromEpoch(message.time.created, now);
          const rootNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: `${state.nativeSessionId}:root:${message.id}`,
          });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: OPENCODE_PROVIDER,
            nativeTurnId: message.id,
          });
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: providerTurnId,
            providerThreadId: state.providerThread.id,
            nodeId: rootNodeId,
            runAttemptId: null,
            nativeTurnRef: providerRef(message.id, "weak"),
            ordinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveOpenCodeTurn = {
            isRoot: false,
            childCall,
            threadId: state.appThread.id,
            runId: null,
            rootNodeId,
            appThread: state.appThread,
            modelSelection: state.appThread.modelSelection,
            runtimePolicy: state.parentSubagent.parentTurn.runtimePolicy,
            providerTurnId,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnOrdinal: providerTurn.ordinal,
            runOrdinal: state.parentSubagent.parentTurn.runOrdinal,
            runAttemptId: null,
            startedAt,
            itemOrdinals: new Map(),
            usage: makeOpenCodeTurnTokenUsageAccumulator(),
            parts: new Map(),
            partIdsByMessage: new Map(),
            toolNamesByCallId: new Map(),
            providerTurn,
            nextItemOrdinal: 1,
            nativeUserMessageId: message.id,
            admissionMessageId: null,
            interrupted: false,
            finalized: false,
            contextOverflow: null,
            planId: null,
            admissionGeneration: 0,
            admissionReconciliationGeneration: null,
            admissionPending: false,
            admissionAccepted: true,
            admissionMessageObserved: true,
            idleDuringAdmission: false,
            admissionUncertain: false,
            admissionStatusSequence: 0,
            admissionSettled: Deferred.makeUnsafe<void>(),
            admissionAbortController: null,
          };
          state.activeTurn = turn;
          state.providerTurns.set(String(providerTurnId), providerTurn);
          yield* emitProviderEvent({
            type: "node.updated",
            driver: OPENCODE_PROVIDER,
            node: {
              id: rootNodeId,
              threadId: turn.threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId,
              nativeItemRef: providerRef(message.id, "weak"),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt: null,
            },
          });
          yield* emitProviderTurn(state, turn, "running", null);
          return turn;
        });

        const projectChildUserPart = Effect.fnUntraced(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          part: Extract<OpenCodePart, { type: "text" }>,
        ) {
          const now = yield* DateTime.now;
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.messageID,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: OPENCODE_PROVIDER,
            nativeItemId: part.messageID,
          });
          const projected: OrchestrationV2ConversationMessage = {
            createdBy: "agent",
            creationSource: "provider",
            id: messageId,
            threadId: turn.threadId,
            runId: null,
            nodeId: turn.rootNodeId,
            role: "user",
            text: part.text,
            attachments: [],
            streaming: false,
            createdAt: turn.startedAt,
            updatedAt: now,
          };
          yield* emitProviderEvent({
            type: "message.updated",
            driver: OPENCODE_PROVIDER,
            message: projected,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              createdBy: "agent",
              creationSource: "provider",
              id: turnItemId,
              threadId: turn.threadId,
              runId: null,
              nodeId: turn.rootNodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(part.messageID),
              parentItemId: null,
              ordinal: itemOrdinal(turn, part.messageID),
              status: "completed",
              title: null,
              startedAt: projected.createdAt,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text: part.text,
              attachments: [],
            },
          });
        });

        const emitCompactionItem = Effect.fn("OpenCodeAdapterV2.emitCompactionItem")(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
        ) {
          const nativeItemId = `${turn.providerTurnId}:compaction`;
          if (turn.itemOrdinals.has(nativeItemId)) return;
          const now = yield* DateTime.now;
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: OPENCODE_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: OPENCODE_PROVIDER,
                nativeItemId,
              }),
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              parentItemId: null,
              ordinal: itemOrdinal(turn, nativeItemId),
              type: "compaction",
              driver: OPENCODE_PROVIDER,
              status: "completed",
              title: "Context compacted",
              startedAt: turn.startedAt,
              completedAt: now,
              updatedAt: now,
            },
          });
        });

        const handleMessageUpdated = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.updated" }>,
          historical = false,
        ) {
          const state = threads.get(event.properties.sessionID);
          if (state === undefined) return;
          const message = event.properties.info;
          state.messageRoles.set(message.id, message.role);
          if (message.role === "assistant") {
            const usage = state.activeTurn?.usage;
            if (usage === undefined) return;
            const prior = usage.assistantOwnershipByMessageId.get(message.id);
            const ownership =
              prior !== undefined && prior !== "unknown"
                ? prior
                : !message.parentID
                  ? "unknown"
                  : usage.promptMessageIds.has(message.parentID)
                    ? "owned"
                    : "other";
            usage.assistantOwnershipByMessageId.set(message.id, ownership);
            if (ownership !== "unknown") {
              if (ownership === "owned") {
                for (const step of usage.unresolvedStepsByMessageId.get(message.id)?.values() ??
                  []) {
                  accumulateOpenCodeStepUsage(usage, step);
                }
              }
              usage.unresolvedStepsByMessageId.delete(message.id);
            }
            return;
          }
          const commandReceipt = commandReceipts.get(message.id);
          if (commandReceipt) yield* Deferred.succeed(commandReceipt, undefined);
          const isNewUserMessage = !state.userMessageIds.includes(message.id);
          if (isNewUserMessage) state.userMessageIds.push(message.id);
          if (historical) {
            state.activeTurn?.priorWakePromptIds?.add(message.id);
            state.activeTurn?.usage.promptMessageIds.add(message.id);
            return;
          }
          let turn = state.activeTurn;
          if (turn === null && state.parentSubagent !== null && isNewUserMessage) {
            turn = yield* createChildTurn(state, message);
          }
          const matchesAdmission =
            turn !== null &&
            (turn.admissionMessageId === null || turn.admissionMessageId === message.id);
          if (turn !== null && matchesAdmission) turn.usage.promptMessageIds.add(message.id);
          if (turn !== null && matchesAdmission && turn.nativeUserMessageId === null) {
            turn.nativeUserMessageId = message.id;
            yield* emitProviderTurn(state, turn, "running", null);
          }
          if (turn !== null && matchesAdmission && turn.admissionPending) {
            if (advanceOpenCodePromptAdmission(turn, "user-message") === "reconcile-idle") {
              yield* reconcilePromptAdmission(state, turn);
            }
          }
        });

        const handlePartUpdated = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.part.updated" }>,
        ) {
          const part = event.properties.part;
          const state = threads.get(part.sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined || turn.finalized) return;
          if (part.type === "text" && state.messageRoles.get(part.messageID) === "user") {
            if (!turn.isRoot) yield* projectChildUserPart(state, turn, part);
            return;
          }
          if (part.type === "step-finish") {
            const usage = turn.usage;
            const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
            if (ownership === "owned") accumulateOpenCodeStepUsage(usage, part);
            else if (
              ownership === "unknown" ||
              (ownership === undefined && !state.messageRoles.has(part.messageID))
            ) {
              const steps =
                usage.unresolvedStepsByMessageId.get(part.messageID) ??
                new Map<string, OpenCodeStepUsage>();
              steps.set(part.id, { id: part.id, tokens: part.tokens });
              usage.unresolvedStepsByMessageId.set(part.messageID, steps);
            }
            return;
          }
          if (part.type === "tool") {
            turn.toolNamesByCallId.set(part.callID, part.tool);
          } else {
            turn.parts.set(part.id, part);
            const ids = turn.partIdsByMessage.get(part.messageID) ?? new Set<string>();
            ids.add(part.id);
            turn.partIdsByMessage.set(part.messageID, ids);
          }
          switch (part.type) {
            case "text":
            case "reasoning":
              yield* emitTextPart(state, turn, part);
              return;
            case "tool":
              yield* emitToolPart(state, turn, part);
              return;
            default:
              return;
          }
        });

        const handlePartDelta = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.part.delta" }>,
        ) {
          if (event.properties.field !== "text") return;
          const state = threads.get(event.properties.sessionID);
          const turn = state?.activeTurn;
          const current = turn?.parts.get(event.properties.partID);
          if (
            state === undefined ||
            turn === null ||
            turn === undefined ||
            current === undefined ||
            (current.type !== "text" && current.type !== "reasoning")
          ) {
            return;
          }
          const updated = { ...current, text: current.text + event.properties.delta };
          turn.parts.set(updated.id, updated);
          yield* emitTextPart(state, turn, updated);
        });

        const handleAssistantCompleted = Effect.fnUntraced(function* (
          event: Extract<OpenCodeEvent, { type: "message.updated" }>,
          historical = false,
        ) {
          const message = event.properties.info;
          if (message.role !== "assistant" || message.time.completed === undefined) return;
          const state = threads.get(message.sessionID);
          const turn = state?.activeTurn;
          if (state === undefined || turn === null || turn === undefined) return;
          // Versions may ignore supplied message IDs; completed assistant output admits settlement on idle.
          if (!historical && !turn.priorWakePromptIds?.has(message.parentID ?? "")) {
            advanceOpenCodePromptAdmission(turn, "assistant-completed");
          }
          for (const partId of turn.partIdsByMessage.get(message.id) ?? []) {
            const part = turn.parts.get(partId);
            if (part?.type === "text" || part?.type === "reasoning") {
              yield* emitTextPart(state, turn, part, true);
            }
          }
        });

        const onSessionIdle = Effect.fnUntraced(function* (sessionId: string) {
          const wasBusy = busySessionIds.delete(sessionId);
          childOutcomes.clearUnstarted(sessionId);
          const state = threads.get(sessionId);
          const turn = state?.activeTurn;
          if (turn == null || state === undefined) {
            if (
              (wasBusy && relatedSessionOwners.has(sessionId)) ||
              subagentsByChildSessionId.has(sessionId)
            )
              yield* concludeChild(sessionId, "completed");
          } else if (turn.priorWakeSettled !== undefined) {
            if (turn.contextOverflow !== null) yield* finalizeTurn(state, turn, "completed");
            else yield* Deferred.succeed(turn.priorWakeSettled, undefined);
          } else if (turn.admissionPending) {
            turn.admissionStatusSequence++;
            advanceOpenCodePromptAdmission(turn, "idle");
          } else {
            yield* finalizeTurn(state, turn, turn.interrupted ? "interrupted" : "completed");
          }
        });

        const routeEvent = Effect.fnUntraced(function* (
          event: OpenCodeEvent,
          historicalRootSessionId?: string,
        ) {
          const sessionId = openCodeWorkSessionId(event);
          const replayed = sessionId !== undefined && sessionId === historicalRootSessionId;
          const historical =
            replayed ||
            (sessionId !== undefined &&
              threads.get(sessionId)?.activeTurn?.priorWakeSettled !== undefined);
          if (
            replayed &&
            (event.type === "session.status" ||
              event.type === "session.idle" ||
              (event.type === "session.error" &&
                event.properties.error?.name !== "ContextOverflowError"))
          )
            return;
          switch (event.type) {
            case "server.connected":
              if (hasConnected) {
                for (const state of threads.values()) {
                  if (state.activeTurn !== null) state.activeTurn.usage.complete = false;
                }
              }
              hasConnected = true;
              return;
            case "message.updated":
              yield* handleMessageUpdated(event, historical);
              yield* handleAssistantCompleted(event, historical);
              return;
            case "session.compacted": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== undefined && state.activeTurn !== null) {
                state.activeTurn.contextOverflow = null;
                yield* emitCompactionItem(state, state.activeTurn);
              }
              return;
            }
            case "message.part.updated":
              yield* handlePartUpdated(event);
              return;
            case "message.part.delta":
              yield* handlePartDelta(event);
              return;
            case "todo.updated": {
              const state = threads.get(event.properties.sessionID);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                yield* emitTodo(state, state.activeTurn, event.properties.todos);
              }
              return;
            }
            case "permission.asked":
              yield* routeRuntimeRequest(event.properties.id, event.properties.sessionID, {
                type: "permission",
                value: event.properties,
              });
              return;
            case "question.asked":
              yield* routeRuntimeRequest(event.properties.id, event.properties.sessionID, {
                type: "question",
                value: event.properties,
              });
              return;
            case "permission.replied":
            case "question.replied":
              rememberSettledRequest(event.properties.requestID);
              yield* resolveRuntimeRequest(event.properties.requestID, "resolved");
              return;
            case "question.rejected":
              rememberSettledRequest(event.properties.requestID);
              yield* resolveRuntimeRequest(event.properties.requestID, "cancelled");
              return;
            case "session.created":
            case "session.updated": {
              const info = event.properties.info;
              if (info.parentID !== undefined) {
                const owner = threads.get(info.parentID) ?? relatedSessionOwners.get(info.parentID);
                if (owner !== undefined) {
                  if (!threads.has(info.id)) relatedSessionOwners.set(info.id, owner);
                  if (event.type === "session.created")
                    childOutcomes.created(info.id, busySessionIds.has(info.id));
                }
              }
              return;
            }
            case "session.deleted":
              relatedSessionOwners.delete(event.properties.info.id);
              busySessionIds.delete(event.properties.info.id);
              childOutcomes.clearUnstarted(event.properties.info.id);
              yield* concludeChild(event.properties.info.id, "interrupted");
              return;
            case "session.status": {
              const { sessionID, status } = event.properties;
              if (status.type === "idle") return yield* onSessionIdle(sessionID);
              childOutcomes.clearUnstarted(sessionID);
              childOutcomes.start(subagentsByChildSessionId.get(sessionID)?.childExecution);
              const state = threads.get(sessionID);
              if (state !== undefined || relatedSessionOwners.has(sessionID))
                busySessionIds.add(sessionID);
              if (state?.activeTurn?.admissionPending) state.activeTurn.admissionStatusSequence++;
              if (status.type === "busy" && state !== undefined) {
                yield* updateProviderThread(state, { status: "active" });
              }
              return;
            }
            case "session.idle":
              return yield* onSessionIdle(event.properties.sessionID);
            case "session.error": {
              const overflowTurn =
                event.properties.error?.name === "ContextOverflowError" &&
                event.properties.sessionID !== undefined
                  ? threads.get(event.properties.sessionID)?.activeTurn
                  : undefined;
              if (overflowTurn !== undefined && overflowTurn !== null) {
                // OpenCode stays busy and auto-compacts; the turn fails only if it idles uncompacted.
                overflowTurn.contextOverflow = makeProviderFailure({
                  message: openCodeErrorMessage(event),
                  code: "ContextOverflowError",
                  class: "provider_error",
                });
                return;
              }
              const states =
                event.properties.sessionID === undefined
                  ? Array.from(threads.values()).filter((state) => state.activeTurn !== null)
                  : [threads.get(event.properties.sessionID)].filter(
                      (state): state is OpenCodeThreadState => state !== undefined,
                    );
              const childId = event.properties.sessionID;
              const unprojectedChild =
                childId !== undefined &&
                !states.some((state) => state.parentSubagent === null || state.activeTurn !== null);
              const error = event.properties.error;
              const usageLimit = error?.name === "APIError" && error.data.statusCode === 429;
              const failure = makeProviderFailure({
                message: openCodeErrorMessage(event),
                code: error?.name ?? null,
                class: usageLimit ? "usage_limit" : "provider_error",
              });
              if (
                !isMessageAbortedError(event) &&
                (event.properties.sessionID === undefined ||
                  states.some((state) => state.parentSubagent === null))
              ) {
                yield* updateProviderSession("error", failure.message);
              }
              for (const state of states) {
                if (state.activeTurn !== null) {
                  yield* finalizeTurn(
                    state,
                    state.activeTurn,
                    terminalStatusForError(event, state.activeTurn),
                    {
                      failure,
                      threadDisposition:
                        event.properties.sessionID === undefined ? "broken" : "reusable",
                    },
                  );
                }
              }
              if (unprojectedChild) {
                busySessionIds.delete(childId);
                childOutcomes.clearUnstarted(childId);
                yield* concludeChild(
                  childId,
                  isMessageAbortedError(event) ? "interrupted" : "failed",
                );
              }
              return;
            }
            default:
              return;
          }
        });

        const abortRoot = (sessionId: string) =>
          sdkCall("session.abort", { sessionID: sessionId }, (signal) =>
            client.session.abort({ sessionID: sessionId }, { signal }),
          ).pipe(Effect.timeout(STOP_CONFIRM_TIMEOUT_MS));

        const cleanupSessionWork = Effect.fn("OpenCode.cleanupSessionWork")(function* <E>(
          sessionId: string,
          abort: Effect.Effect<unknown, E>,
        ) {
          const root = yield* abort.pipe(Effect.result);
          const descendants = yield* abortDescendants(sessionId).pipe(
            Effect.timeout("10 seconds"),
            Effect.result,
          );
          if (descendants._tag === "Success") yield* stopDetachedChildren(sessionId);
          if (root._tag === "Failure") return yield* Effect.fail(root.failure);
          if (descendants._tag === "Failure") return yield* descendants.failure;
        });

        const breakSession = Effect.fn("OpenCode.breakSession")(function* (
          detail: string,
        ): Effect.fn.Return<void> {
          nativeStreamFailure ??= makeProviderFailure({
            message: detail,
            class: "transport_error",
          });
          busySessionIds.clear();
          yield* background.close();
          yield* updateProviderSession("error", nativeStreamFailure.message);
          for (const state of threads.values()) {
            if (state.activeTurn !== null) yield* finalizeTurn(state, state.activeTurn, "failed");
          }
          for (const launch of launches) yield* loseLaunch(launch);
        });

        const background = makeOpenCodeBackgroundTurns({
          ownerOf: (sessionId) => threads.get(sessionId) ?? relatedSessionOwners.get(sessionId),
          isClosed: () => closing || nativeStreamFailure !== null,
          makeMessageId: (sessionId, promptId) =>
            idAllocator.derive.messageFromProviderItem({
              driver: OPENCODE_PROVIDER,
              nativeItemId: `${sessionId}:background:${promptId}`,
            }),
          offer: continuationRequests.offer,
          abortRoot: (state) => abortRoot(state.nativeSessionId),
          cleanup: (state, root) => cleanupSessionWork(state.nativeSessionId, root),
          breakSession,
        });

        const acceptEvent = Effect.fnUntraced(function* (event: OpenCodeEvent) {
          if (!(yield* background.hold(event))) yield* routeEvent(event);
        });

        const handleEvent = Effect.fnUntraced(function* (event: OpenCodeEvent) {
          yield* logProtocolEvent({
            direction: "incoming",
            messageKind: "notification",
            method: event.type,
            payload: event,
          });
          yield* background.serializeEvents(acceptEvent(event));
        });

        const inputProviderSessionId = input.providerSessionId;

        const subscription = yield* sdkCall("event.subscribe", {}, () =>
          client.event.subscribe(undefined, { signal: abortController.signal }),
        );
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => abortController.abort()),
        );
        yield* Stream.fromAsyncIterable(
          subscription.stream,
          (cause) =>
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "event.subscribe",
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
        ).pipe(
          Stream.runForEach(handleEvent),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              busySessionIds.clear();
              if (closing || abortController.signal.aborted) return;
              const detail = Exit.isSuccess(exit)
                ? "OpenCode event stream ended unexpectedly."
                : OpenCodeRuntime.openCodeRuntimeErrorDetail(Cause.squash(exit.cause));
              yield* breakSession(detail);
              yield* Queue.end(events);
            }),
          ),
          Effect.forkIn(scope),
        );

        if (!connection.external && connection.exitCode !== null) {
          yield* connection.exitCode.pipe(
            Effect.flatMap((code) =>
              abortController.signal.aborted
                ? Effect.void
                : background.serializeEvents(
                    breakSession(`OpenCode server exited unexpectedly (${code}).`),
                  ),
            ),
            Effect.forkIn(scope),
          );
        }

        if (connection.external) {
          yield* Scope.addFinalizer(
            scope,
            Effect.suspend(() =>
              Effect.forEach(
                Array.from(threads.values()).filter((state) => state.parentSubagent === null),
                (state) =>
                  sdkCall("session.abort", { sessionID: state.nativeSessionId }, (signal) =>
                    client.session.abort({ sessionID: state.nativeSessionId }, { signal }),
                  ).pipe(
                    Effect.timeout("1 second"),
                    Effect.ignore({ log: true }),
                    Effect.andThen(
                      abortDescendants(state.nativeSessionId).pipe(
                        Effect.timeout("1 second"),
                        Effect.ignore({ log: true }),
                      ),
                    ),
                  ),
                { concurrency: 8, discard: true },
              ),
            ),
          );
        }

        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            closing = true;
          }).pipe(Effect.andThen(background.close)),
        );

        const registerThread = (
          nativeSession: OpenCodeSession,
          providerThread: OrchestrationV2ProviderThread,
          appThread: OrchestrationV2AppThread | null,
        ): OpenCodeThreadState => {
          const existing = threads.get(nativeSession.id);
          if (existing !== undefined) {
            existing.providerThread = providerThread;
            if (appThread !== null) existing.appThread = appThread;
            return existing;
          }
          const state: OpenCodeThreadState = {
            nativeSessionId: nativeSession.id,
            providerThread,
            appThread,
            activeTurn: null,
            providerTurns: new Map(),
            runtimeRequests: new Map(),
            messageRoles: new Map(),
            userMessageIds: [],
            parentSubagent: subagentsByChildSessionId.get(nativeSession.id) ?? null,
            nextChildTurnOrdinal: 1,
            nextAdmissionGeneration: 1,
            permission: nativeSession.permission ?? [],
            metadata: nativeSession.metadata,
            subagentsDenied: openCodeOwnsSubagentDeny(nativeSession),
          };
          threads.set(nativeSession.id, state);
          return state;
        };

        const resolvePromptParts = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          const text = (yield* providerMessageTextWithAttachmentPaths({
            text: turnInput.message.text,
            attachments: turnInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          })).trim();
          const files = OpenCodeRuntime.toOpenCodeFileParts({
            attachments: turnInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
          });
          if (text.length === 0 && files.length === 0) {
            throw protocolError("OpenCode turns require text or at least one valid attachment");
          }
          return [...(text.length === 0 ? [] : [{ type: "text" as const, text }]), ...files];
        });

        const readSnapshot = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const sessionId = nativeThreadId(providerThread);
          const sessionResponse = yield* sdkCall("session.get", { sessionID: sessionId }, () =>
            client.session.get({ sessionID: sessionId }),
          );
          const nativeSession = unwrapData("session.get", sessionResponse);
          const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
            client.session.messages({ sessionID: sessionId }),
          );
          const nativeMessages = [];
          for (const entry of unwrapData("session.messages", response)) {
            // Reverted records remain in messages; stop at the revert marker to avoid resurrecting work.
            if (entry.info.id === nativeSession.revert?.messageID) break;
            nativeMessages.push(entry);
          }
          const state = threads.get(sessionId);
          const snapshotNow = yield* DateTime.now;
          const messages: Array<OrchestrationV2ConversationMessage> = nativeMessages.flatMap(
            ({ info, parts }) => {
              const text = parts
                .filter(
                  (part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text",
                )
                .filter((part) => part.ignored !== true && part.synthetic !== true)
                .map((part) => part.text)
                .join("\n");
              if (text.length === 0) return [];
              const createdAt = dateTimeFromEpoch(info.time.created, snapshotNow);
              return [
                {
                  createdBy: info.role === "user" ? "user" : "agent",
                  creationSource: "provider",
                  id: idAllocator.derive.messageFromProviderItem({
                    driver: OPENCODE_PROVIDER,
                    nativeItemId: info.id,
                  }),
                  threadId: providerThread.appThreadId ?? input.threadId,
                  runId: null,
                  nodeId: null,
                  role: info.role,
                  text,
                  attachments: [],
                  streaming: false,
                  createdAt,
                  updatedAt:
                    info.role === "assistant"
                      ? dateTimeFromEpoch(info.time.completed, createdAt)
                      : createdAt,
                },
              ];
            },
          );
          const lastUser = nativeMessages.findLast(({ info }) => info.role === "user")?.info.id;
          return {
            providerThread: {
              ...providerThread,
              providerSessionId: input.providerSessionId,
              nativeConversationHeadRef:
                lastUser === undefined ? null : providerRef(lastUser, "weak"),
              status: "idle" as const,
              updatedAt: snapshotNow,
            },
            providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
            messages,
            runtimeRequests: state === undefined ? [] : [...state.runtimeRequests.values()],
            providerPayload: nativeMessages,
          };
        });

        const updatePermission = (sessionID: string, body: OpenCodePermissionUpdate) =>
          sdkCall("session.update", { sessionID, ...body }, (signal) =>
            client.session.update({ sessionID, ...body }, { signal }),
          );

        const syncSubagentRules = (state: OpenCodeThreadState, subagentsOff: boolean) =>
          syncOpenCodeSubagentDeny(state, subagentsOff, threads.values(), updatePermission);

        const resumedChildPolicies = new WeakMap<
          OpenCodeThreadState,
          { base?: PermissionRuleset; subagentsOff?: boolean }
        >();
        const listNativeChildren = (id: string) =>
          sdkCall("session.children", { sessionID: id }, (signal) =>
            client.session.children({ sessionID: id }, { signal }),
          ).pipe(Effect.map((response) => unwrapData("session.children", response)));

        // OpenCode runs a command as a subtask without checking `task`: an explicit flag wins, or
        // else a subagent-mode agent makes it one. Anything GOAT cannot read counts as a subtask.
        const commandRunsAsSubtask = Effect.fn("OpenCodeAdapter.commandRunsAsSubtask")(
          function* (name: string, promptAgent: string | undefined) {
            const commands = yield* sdkCall("command.list", {}, (signal) =>
              client.command.list(undefined, { signal }),
            );
            const command = commands.data?.find((entry) => entry.name === name);
            if (command === undefined) return true;
            if (command.subtask !== undefined) return command.subtask;
            const agentName = command.agent ?? promptAgent;
            if (agentName === undefined) return false;
            const agents = yield* sdkCall("app.agents", {}, (signal) =>
              client.app.agents(undefined, { signal }),
            );
            const agent = agents.data?.find((entry) => entry.name === agentName);
            return agent === undefined || agent.mode === "subagent";
          },
          Effect.orElseSucceed(() => true),
        );

        const refreshPromptPermissions = Effect.fn("OpenCode.refreshPromptPermissions")(function* (
          state: OpenCodeThreadState,
          threadId: ThreadId,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
        ) {
          const subagentsOff = (yield* mcpSessions.read(threadId))?.nativeSubagentLimit === 0;
          if (state.permissionRefreshPending === true) {
            yield* installResumedOpenCodePermission({
              state,
              session: {},
              runtimePolicy: runtimePolicy,
              subagentsOff,
              failure: "raise",
              listNativeChildren,
              update: updatePermission,
            });
          }
          yield* syncSubagentRules(state, subagentsOff);
          const previous = resumedChildPolicies.get(state);
          const base = openCodePermissionRules(runtimePolicy);
          const scan =
            previous !== undefined &&
            (previous.subagentsOff !== subagentsOff ||
              previous.base === undefined ||
              !openCodePermissionRulesEqual(previous.base, base));
          yield* refreshOpenCodeChildPermissions({
            root: state,
            children: threads.values(),
            policy: runtimePolicy,
            subagentsOff,
            scanNative: scan,
            listNativeChildren,
            update: updatePermission,
          });
          if (scan) resumedChildPolicies.set(state, { base, subagentsOff });
          return subagentsOff;
        }, Effect.timeout("10 seconds"));

        // Native commands await generation; user-message receipts admit their background requests.
        const submitPrompt = Effect.fn("OpenCode.submitPrompt")(function* (
          state: OpenCodeThreadState,
          turn: ActiveOpenCodeTurn,
          inputPayload: Parameters<typeof client.session.promptAsync>[0] & {
            messageID: string;
            sessionID: string;
          },
          abortController: AbortController,
          memoryInput?: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          const { variant, ...payloadWithoutVariant } = inputPayload;
          const selectedVariant = yield* resolveOpenCodeVariant(
            client,
            inputPayload.model,
            variant,
            abortController.signal,
            variantCache,
          );
          const payload = {
            ...payloadWithoutVariant,
            ...(selectedVariant === undefined ? {} : { variant: selectedVariant }),
          };
          const text = payload.parts
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          const match = text?.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
          const command = match
            ? (yield* OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
                Effect.timeout("10 seconds"),
                Effect.orElseSucceed(() => []),
              )).find((entry) => entry.name === match[1])
            : undefined;
          const currentMcp =
            memoryInput === undefined ? undefined : yield* mcpSessions.read(memoryInput.threadId);
          const subagentsOff = yield* refreshPromptPermissions(
            state,
            turn.threadId,
            turn.runtimePolicy,
          );
          if (
            command !== undefined &&
            subagentsOff &&
            (yield* commandRunsAsSubtask(command.name, payload.agent))
          )
            return yield* protocolError(
              `/${command.name} runs as an OpenCode subtask, and this thread's GOAT permission profile allows no native subagents.`,
            );
          if (
            memoryInput !== undefined &&
            !connection.external &&
            (currentMcp?.authorizationHeader !== installedMcpSession?.authorizationHeader ||
              currentMcp?.endpoint !== installedMcpSession?.endpoint)
          ) {
            if (currentMcp === undefined) {
              yield* sdkCall("mcp.disconnect", { name: "goat" }, (signal) =>
                client.mcp.disconnect({ name: "goat" }, { signal }),
              );
            } else {
              yield* sdkCall("mcp.add", { name: "goat" }, (signal) =>
                client.mcp.add(
                  {
                    name: "goat",
                    config: goatRemoteMcpConfig(
                      currentMcp.endpoint,
                      currentMcp.authorizationHeader,
                    ),
                  },
                  { signal },
                ),
              );
            }
            installedMcpSession = currentMcp;
          }
          // Native workspace commands accept file parts only, so snapshots stay on prompts.
          if (!command) {
            const snapshot =
              memoryInput === undefined
                ? undefined
                : memoryInput.refreshMemoryContext
                  ? yield* memoryInput.refreshMemoryContext()
                  : memoryInput.memoryContext;
            const memory =
              snapshot === undefined
                ? undefined
                : yield* Effect.try({
                    try: () => MemoryContext.memoryContextText(snapshot),
                    catch: () =>
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: OPENCODE_PROVIDER,
                        detail: "Invalid memory context frame",
                      }),
                  });
            const availability = McpProviderSession.memoryToolAvailability(
              !connection.external &&
                currentMcp?.authorizationHeader === installedMcpSession?.authorizationHeader &&
                currentMcp?.endpoint === installedMcpSession?.endpoint
                ? currentMcp
                : undefined,
            );
            const hasMemoryTools = availability.read || availability.write || availability.source;
            const prepared =
              memory === undefined && !hasMemoryTools
                ? payload
                : {
                    ...payload,
                    system: [
                      payload.system,
                      memory === undefined
                        ? undefined
                        : MemoryContext.MEMORY_DATA_BOUNDARY_REMINDER,
                      hasMemoryTools
                        ? `GOAT memory tools: read=${availability.read}, write=${availability.write}, source=${availability.source}. Unavailable or denied tools must not be claimed.`
                        : undefined,
                      memory,
                    ]
                      .filter((part) => part !== undefined)
                      .join("\n\n"),
                  };
            return yield* sdkCall("session.promptAsync", prepared, (signal) =>
              client.session.promptAsync(prepared, {
                signal: AbortSignal.any([signal, abortController.signal]),
              }),
            ).pipe(Effect.asVoid);
          }
          const receipt = Deferred.makeUnsafe<void>();
          commandReceipts.set(payload.messageID, receipt);
          const controllers =
            commandControllers.get(payload.sessionID) ?? new Set<AbortController>();
          controllers.add(abortController);
          commandControllers.set(payload.sessionID, controllers);
          const generation = turn.admissionGeneration;
          const commandPayload = {
            sessionID: payload.sessionID,
            messageID: payload.messageID,
            command: command.name,
            arguments: match?.[2] ?? "",
            ...(payload.model
              ? { model: `${payload.model.providerID}/${payload.model.modelID}` }
              : {}),
            ...(payload.agent ? { agent: payload.agent } : {}),
            ...(payload.variant ? { variant: payload.variant } : {}),
            parts: payload.parts?.filter((part) => part.type === "file") ?? [],
          };
          const request = yield* sdkCall("session.command", commandPayload, (signal) =>
            client.session.command(commandPayload, {
              signal: AbortSignal.any([signal, abortController.signal]),
            }),
          ).pipe(
            Effect.asVoid,
            // OpenCode answers only when generation ends; once admitted, the event stream owns the outcome.
            Effect.tapError((cause) =>
              Deferred.isDoneUnsafe(receipt) ||
              abortController.signal.aborted ||
              turn.finalized ||
              turn.admissionGeneration !== generation
                ? Effect.void
                : finalizeTurn(state, turn, "failed", {
                    failure: makeProviderFailure({ cause, class: "provider_error" }),
                  }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                commandReceipts.delete(payload.messageID);
                controllers.delete(abortController);
                if (controllers.size === 0) commandControllers.delete(payload.sessionID);
              }),
            ),
            Effect.forkIn(scope),
          );
          yield* Effect.raceFirst(Fiber.join(request), Deferred.await(receipt)).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              TimeoutError: (cause) => {
                const error = new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "session.command",
                  detail: "OpenCode command admission did not complete within 10 seconds.",
                  cause,
                });
                abortController.abort();
                return finalizeTurn(state, turn, "failed", {
                  failure: makeProviderFailure({ cause: error, class: "provider_error" }),
                }).pipe(Effect.andThen(Effect.fail(error)));
              },
            }),
          );
        });

        const interruptTurn = Effect.fn("OpencodeAdapter.interruptTurn")(
          function* (
            interruptInput: ProviderAdapter.ProviderAdapterV2InterruptInput,
            deadline: OpenCodeStopDeadline,
          ) {
            const sessionId = nativeThreadId(interruptInput.providerThread);
            const state = threads.get(sessionId);
            const turn = state?.activeTurn;
            if (
              (turn === undefined || turn === null) &&
              interruptInput.requestRuntimeRestart === true
            ) {
              for (const controller of commandControllers.get(sessionId) ?? []) controller.abort();
              yield* interruptInput.onRootStopResolved ?? Effect.void;
              if (state === undefined) yield* cleanupSessionWork(sessionId, Effect.void);
              else yield* background.stop(state);
              return;
            }
            if (
              state === undefined ||
              turn === null ||
              turn === undefined ||
              turn.providerTurnId !== interruptInput.providerTurnId
            ) {
              return yield* protocolError(
                `OpenCode turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            for (const controller of commandControllers.get(sessionId) ?? []) controller.abort();
            const admissionWasPending = turn.admissionPending;
            cancelOpenCodePromptAdmission(turn, state.nextAdmissionGeneration++);
            turn.admissionAbortController?.abort();
            if (turn.priorWakeSettled !== undefined)
              yield* Deferred.succeed(turn.priorWakeSettled, undefined);
            if (admissionWasPending) {
              // Local admission timeout must not block the server-side abort.
              yield* Deferred.await(turn.admissionSettled).pipe(
                Effect.timeout("10 seconds"),
                Effect.ignore,
              );
            }
            yield* cleanupSessionWork(
              sessionId,
              resolveOpenCodeRootStop(abortRoot(sessionId), turn, interruptInput, deadline),
            );
          },
          (effect, interruptInput) => {
            const id = interruptInput.providerThread.nativeThreadRef?.nativeId;
            return background
              .serializeLifecycle(id == null ? effect : childOutcomes.withStop(id, effect))
              .pipe(
                Effect.mapError((cause) =>
                  cause._tag === "ProviderAdapterInterruptTimeoutError"
                    ? cause
                    : new ProviderAdapter.ProviderAdapterInterruptError({
                        driver: OPENCODE_PROVIDER,
                        providerThreadId: interruptInput.providerThread.id,
                        providerTurnId: interruptInput.providerTurnId,
                        cause,
                      }),
                ),
              );
          },
        );

        const runtimeSession: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver: OPENCODE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: sessionEntity,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          hasPendingBackgroundWork: Effect.sync(
            () => busySessionIds.size > 0 || launches.size > 0 || background.hasOffered(),
          ),
          holdsLiveWork: openCodeLiveWork(
            () => pendingRequests.size > 0 || background.hasOffered(),
            () => busySessionIds,
            () =>
              sdkCall("session.status", {}, () => client.session.status()).pipe(
                Effect.map((response) => unwrapData("session.status", response)),
              ),
          ),
          ensureThread: Effect.fn("OpencodeAdapter.ensureThread")(
            function* (threadInput) {
              if (threadInput.existingProviderThread?.nativeThreadRef != null) {
                return yield* runtimeSession.resumeThread({
                  providerThread: threadInput.existingProviderThread,
                  runtimePolicy: threadInput.runtimePolicy,
                  threadId: threadInput.threadId,
                });
              }
              // OpenCode generates a title only when session.create leaves it unset.
              const installed = openCodeInstalledPermission(threadInput.runtimePolicy);
              const response = yield* sdkCall("session.create", installed, () =>
                client.session.create(installed),
              );
              const nativeSession = unwrapData("session.create", response);
              const createdAt = yield* DateTime.now;
              const created = makeProviderThread({
                idAllocator,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                nativeSession,
                now: createdAt,
              });
              const existing = threadInput.existingProviderThread;
              const providerThread =
                existing === undefined
                  ? created
                  : {
                      ...existing,
                      providerSessionId: input.providerSessionId,
                      nativeThreadRef: created.nativeThreadRef,
                      nativeConversationHeadRef: created.nativeConversationHeadRef,
                      status: created.status,
                      updatedAt: created.updatedAt,
                    };
              const createdState = registerThread(nativeSession, providerThread, null);
              createdState.permission = nativeSession.permission ?? installed.permission;
              createdState.metadata = { ...installed.metadata, ...nativeSession.metadata };
              return providerThread;
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver: OPENCODE_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("OpencodeAdapter.resumeThread")(
            function* (threadInput) {
              const sessionId = nativeThreadId(threadInput.providerThread);
              const response = yield* sdkCall("session.get", { sessionID: sessionId }, () =>
                client.session.get({ sessionID: sessionId }),
              );
              const nativeSession = unwrapData("session.get", response);
              const resumedAt = yield* DateTime.now;
              const providerThread = {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: dateTimeFromEpoch(nativeSession.time.updated, resumedAt),
              };
              const state = registerThread(nativeSession, providerThread, null);
              const mcp = yield* mcpSessions.read(threadInput.threadId ?? input.threadId);
              yield* installResumedOpenCodePermission({
                state,
                session: nativeSession,
                runtimePolicy: threadInput.runtimePolicy,
                subagentsOff: mcp === undefined ? undefined : mcp.nativeSubagentLimit === 0,
                failure: "pending",
                listNativeChildren,
                update: updatePermission,
              });
              resumedChildPolicies.set(state, {});
              return providerThread;
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: OPENCODE_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          compactThread: (turnInput) =>
            runtimeSession.startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compact" },
            }),
          startTurn: Effect.fn("OpencodeAdapter.startTurn")(
            function* (turnInput) {
              if (closing || nativeStreamFailure !== null) {
                return yield* protocolError(
                  "OpenCode event stream has ended; reconnect the provider session before starting another turn.",
                );
              }
              const sessionId = nativeThreadId(turnInput.providerThread);
              const state = threads.get(sessionId);
              if (state === undefined) {
                return yield* protocolError(`OpenCode session ${sessionId} is not registered`);
              }
              if (state.activeTurn !== null) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: OPENCODE_PROVIDER,
                  detail: `OpenCode provider thread ${turnInput.providerThread.id} already has an active turn`,
                  reason: "previous_turn_active",
                });
              }
              const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(
                turnInput.modelSelection.model,
              );
              if (parsedModel === null) {
                return yield* protocolError(
                  `OpenCode model '${turnInput.modelSelection.model}' must use provider/model format`,
                );
              }
              const continuation = openCodeBufferedContinuation(turnInput.message);
              if (continuation && background.matches(state, turnInput.message.messageId)) {
                yield* refreshPromptPermissions(state, turnInput.threadId, turnInput.runtimePolicy);
              }
              const isCompaction =
                !continuation &&
                turnInput.message.text.trim() === "/compact" &&
                turnInput.message.attachments.length === 0;
              const parts =
                isCompaction || continuation ? [] : yield* resolvePromptParts(turnInput);
              const startedAt = yield* DateTime.now;
              const syntheticNativeTurnId = `${sessionId}:attempt:${turnInput.attemptId}`;
              const providerTurnId = idAllocator.derive.providerTurn({
                driver: OPENCODE_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              });
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              };
              const admissionMessageId = continuation
                ? null
                : yield* makeOpenCodeMessageId(messageIdClock);
              const turn: ActiveOpenCodeTurn = {
                isRoot: true,
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                rootNodeId: turnInput.rootNodeId,
                appThread: turnInput.appThread,
                modelSelection: turnInput.modelSelection,
                runtimePolicy: turnInput.runtimePolicy,
                providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnOrdinal: turnInput.providerTurnOrdinal,
                runOrdinal: turnInput.runOrdinal,
                runAttemptId: turnInput.attemptId,
                startedAt,
                itemOrdinals: new Map(),
                usage: makeOpenCodeTurnTokenUsageAccumulator(),
                parts: new Map(),
                partIdsByMessage: new Map(),
                toolNamesByCallId: new Map(),
                providerTurn,
                nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                nativeUserMessageId: null,
                admissionMessageId,
                interrupted: false,
                finalized: false,
                contextOverflow: null,
                planId: null,
                admissionGeneration: state.nextAdmissionGeneration++,
                admissionReconciliationGeneration: null,
                admissionPending: !isCompaction && !continuation,
                admissionAccepted: isCompaction || continuation,
                admissionMessageObserved: false,
                idleDuringAdmission: false,
                admissionUncertain: false,
                admissionStatusSequence: 0,
                admissionSettled: Deferred.makeUnsafe<void>(),
                // @effect-diagnostics-next-line abortControllerInEffect:off - Turn interruption owns prompt admission cancellation.
                admissionAbortController: continuation ? null : new AbortController(),
              };
              if (turn.admissionMessageId !== null)
                turn.usage.promptMessageIds.add(turn.admissionMessageId);
              const admissionSettled = turn.admissionSettled;
              const admissionAbortController = turn.admissionAbortController;
              yield* background.serializeLifecycle(
                Effect.gen(function* () {
                  if (!continuation) yield* background.awaitAdmission(state);
                  yield* background.serializeEvents(
                    Effect.gen(function* () {
                      if (closing || nativeStreamFailure !== null) {
                        return yield* protocolError(
                          "OpenCode event stream has ended; reconnect the provider session before starting another turn.",
                        );
                      }
                      if (state.activeTurn !== null) {
                        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                          driver: OPENCODE_PROVIDER,
                          detail: `OpenCode provider thread ${turnInput.providerThread.id} already has an active turn`,
                          reason: "previous_turn_active",
                        });
                      }
                      const wake = background.take(
                        state,
                        continuation ? turnInput.message.messageId : null,
                      );
                      if (!continuation && wake !== null) {
                        turn.priorWakePromptIds = wake.promptIds;
                        turn.priorWakeSettled = wake.settled;
                      }
                      state.appThread = turnInput.appThread;
                      state.activeTurn = turn;
                      state.providerTurns.set(String(providerTurnId), providerTurn);
                      yield* emitProviderTurn(state, turn, "running", null);
                      yield* updateProviderThread(state, {
                        status: "active",
                        firstRunOrdinal:
                          state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                        lastRunOrdinal: turnInput.runOrdinal,
                      });
                      yield* updateProviderSession("running", null);
                      if (wake === null) {
                        if (continuation) yield* finalizeTurn(state, turn, "completed");
                        return;
                      }
                      yield* Effect.forEach(
                        wake.events,
                        (event) =>
                          state.activeTurn === turn
                            ? routeEvent(event, continuation ? undefined : sessionId)
                            : acceptEvent(event),
                        { discard: true },
                      ).pipe(
                        Effect.timeout("10 seconds"),
                        Effect.onError(() =>
                          breakSession(
                            "OpenCode could not replay buffered work. Reconnect the provider session.",
                          ).pipe(
                            Effect.andThen(cleanupSessionWork(sessionId, abortRoot(sessionId))),
                            Effect.ignore({ log: true }),
                          ),
                        ),
                      );
                      if (
                        !continuation &&
                        turn.contextOverflow !== null &&
                        (yield* Deferred.isDone(wake.settled))
                      ) {
                        yield* finalizeTurn(state, turn, "completed");
                      }
                    }),
                  );
                }),
              );
              if (admissionMessageId === null || admissionAbortController === null) return;
              if (turn.priorWakeSettled !== undefined) {
                yield* Deferred.await(turn.priorWakeSettled);
                delete turn.priorWakeSettled;
                if (!turnIsLive(state, turn)) {
                  yield* Deferred.succeed(admissionSettled, undefined);
                  return;
                }
              }
              if (isCompaction) {
                yield* sdkCall(
                  "session.summarize",
                  { sessionID: sessionId, ...parsedModel, auto: false },
                  (signal) =>
                    client.session.summarize(
                      { sessionID: sessionId, ...parsedModel, auto: false },
                      { signal: AbortSignal.any([signal, admissionAbortController.signal]) },
                    ),
                ).pipe(
                  Effect.tap(() =>
                    turn.interrupted ||
                    turn.finalized ||
                    turn.contextOverflow !== null ||
                    nativeStreamFailure !== null
                      ? Effect.void
                      : emitCompactionItem(state, turn),
                  ),
                  Effect.tap(() =>
                    finalizeTurn(state, turn, turn.interrupted ? "interrupted" : "completed"),
                  ),
                  Effect.tapError((cause) =>
                    finalizeTurn(state, turn, turn.interrupted ? "interrupted" : "failed", {
                      failure: makeProviderFailure({ cause, class: "provider_error" }),
                    }),
                  ),
                  Effect.ensuring(Deferred.succeed(admissionSettled, undefined)),
                );
                return;
              }
              const systemPrompt = [
                orchestrationSystemPrompt,
                buildSessionRuntimeInstructions(yield* mcpSessions.read(turnInput.threadId), {
                  harness: "OpenCode",
                  model: turnInput.modelSelection.model,
                  computerUse:
                    (yield* syncCuaDriver(turnInput.threadId)) &&
                    McpProviderSession.carriesComputerUseSkill(
                      yield* mcpSessions.read(turnInput.threadId),
                    ),
                }),
              ]
                .filter(Boolean)
                .join("\n\n");
              const agent =
                getModelSelectionStringOptionValue(turnInput.modelSelection, "agent") ??
                (turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : undefined);
              const variant = getModelSelectionStringOptionValue(
                turnInput.modelSelection,
                "variant",
              );
              turn.promptOptions = {
                ...(agent === undefined ? {} : { agent }),
                ...(variant === undefined ? {} : { variant }),
                system: systemPrompt,
              };
              yield* submitPrompt(
                state,
                turn,
                {
                  sessionID: sessionId,
                  messageID: admissionMessageId,
                  model: parsedModel,
                  ...turn.promptOptions,
                  parts,
                },
                admissionAbortController,
                turnInput,
              ).pipe(
                Effect.tapError((cause) =>
                  admissionAbortController.signal.aborted
                    ? Effect.void
                    : finalizeTurn(state, turn, "failed", {
                        failure: makeProviderFailure({ cause, class: "provider_error" }),
                      }),
                ),
                Effect.catch((cause) =>
                  admissionAbortController.signal.aborted ? Effect.void : Effect.fail(cause),
                ),
                Effect.ensuring(
                  Effect.all([
                    Deferred.succeed(admissionSettled, undefined).pipe(Effect.ignore),
                    Effect.sync(() => {
                      if (turn.admissionAbortController === admissionAbortController) {
                        turn.admissionAbortController = null;
                      }
                    }),
                  ]).pipe(Effect.asVoid),
                ),
              );
              if (turnIsLive(state, turn)) {
                const admissionAction = advanceOpenCodePromptAdmission(turn, "accepted");
                if (admissionAction === "reconcile-idle") {
                  yield* reconcilePromptAdmission(state, turn);
                }
              }
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.onError(() =>
                  Effect.suspend(() => {
                    if (!openCodeBufferedContinuation(turnInput.message)) return Effect.void;
                    const sessionId = turnInput.providerThread.nativeThreadRef?.nativeId;
                    const state = sessionId == null ? undefined : threads.get(sessionId);
                    return state === undefined
                      ? Effect.void
                      : background.stopIfCurrent(state, turnInput.message.messageId);
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver: OPENCODE_PROVIDER,
                      threadId: turnInput.threadId,
                      providerThreadId: turnInput.providerThread.id,
                      runId: turnInput.runId,
                      cause,
                    }),
                ),
              ),
          ),
          steerTurn: Effect.fn("OpencodeAdapter.steerTurn")(
            function* (steerInput) {
              const sessionId = nativeThreadId(steerInput.providerThread);
              const state = threads.get(sessionId);
              const turn = state?.activeTurn;
              if (
                state === undefined ||
                turn === undefined ||
                turn === null ||
                turn.providerTurnId !== steerInput.providerTurnId ||
                turn.interrupted
              ) {
                return yield* protocolError(
                  `OpenCode turn ${steerInput.providerTurnId} is not active`,
                );
              }
              const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(turn.modelSelection.model);
              if (parsedModel === null) {
                return yield* protocolError(
                  `OpenCode model '${turn.modelSelection.model}' must use provider/model format`,
                );
              }
              const text = (yield* providerMessageTextWithAttachmentPaths({
                text: steerInput.message.text,
                attachments: steerInput.message.attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
                resolveExtractedTextPath: host.resolveExtractedTextPath,
              })).trim();
              if (state.activeTurn !== turn || turn.interrupted || turn.finalized) {
                return yield* protocolError(
                  `OpenCode turn ${steerInput.providerTurnId} is not active`,
                );
              }
              const files = OpenCodeRuntime.toOpenCodeFileParts({
                attachments: steerInput.message.attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
              });
              if (text.length === 0 && files.length === 0) {
                return yield* protocolError("OpenCode steering requires text or an attachment");
              }
              const parts = [
                ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
                ...files,
              ];
              const admissionMessageId = yield* makeOpenCodeMessageId(messageIdClock);
              while (turn.admissionAbortController !== null) {
                const pendingAdmission = turn.admissionSettled;
                yield* Deferred.await(pendingAdmission);
                // Another waiting steer may have claimed admission first.
                if (turn.admissionSettled === pendingAdmission) break;
              }
              if (state.activeTurn !== turn || turn.finalized || turn.interrupted) {
                return yield* protocolError(
                  `OpenCode turn ${steerInput.providerTurnId} is not active`,
                );
              }
              if (!turn.admissionPending) turn.admissionUncertain = false;
              const generation = (turn.admissionGeneration = state.nextAdmissionGeneration++);
              turn.admissionMessageId = admissionMessageId;
              turn.admissionPending = true;
              turn.admissionAccepted = false;
              turn.admissionMessageObserved = false;
              turn.idleDuringAdmission = false;
              turn.admissionSettled = Deferred.makeUnsafe<void>();
              // @effect-diagnostics-next-line abortControllerInEffect:off - Steering replaces the admission request independently of this command fiber.
              turn.admissionAbortController = new AbortController();
              if (turn.admissionMessageId !== null)
                turn.usage.promptMessageIds.add(turn.admissionMessageId);
              const admissionSettled = turn.admissionSettled;
              const admissionAbortController = turn.admissionAbortController;
              const acceptAdmission = Effect.suspend(() =>
                promptAdmissionIsCurrent(state, turn, generation) &&
                advanceOpenCodePromptAdmission(turn, "accepted") === "reconcile-idle"
                  ? reconcilePromptAdmission(state, turn)
                  : Effect.void,
              );
              yield* submitPrompt(
                state,
                turn,
                {
                  sessionID: sessionId,
                  messageID: turn.admissionMessageId,
                  model: parsedModel,
                  ...turn.promptOptions,
                  parts,
                },
                admissionAbortController,
              ).pipe(
                Effect.tapError((error) => {
                  if (!promptAdmissionIsCurrent(state, turn, generation)) return Effect.void;
                  if (isOpenCodePromptRejected(error) && !turn.admissionUncertain) {
                    return reconcilePromptAdmission(state, turn);
                  }
                  turn.admissionUncertain = true;
                  return acceptAdmission;
                }),
                Effect.ensuring(
                  Effect.all([
                    Deferred.succeed(admissionSettled, undefined).pipe(Effect.ignore),
                    Effect.sync(() => {
                      if (turn.admissionAbortController === admissionAbortController) {
                        turn.admissionAbortController = null;
                      }
                    }),
                  ]).pipe(Effect.asVoid),
                ),
              );
              yield* acceptAdmission;
            },
            (effect, steerInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver: OPENCODE_PROVIDER,
                      providerThreadId: steerInput.providerThread.id,
                      providerTurnId: steerInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          interruptTurn: (input) =>
            runOpenCodeStop(scope, (deadline) => interruptTurn(input, deadline)),
          respondToRuntimeRequest: Effect.fn("OpencodeAdapter.respondToRuntimeRequest")(
            function* (requestInput) {
              const pending = pendingRequests.get(String(requestInput.requestId));
              if (pending === undefined) {
                return yield* protocolError(
                  `No pending OpenCode request ${requestInput.requestId}`,
                );
              }
              if (pending.question !== undefined) {
                if (requestInput.answers === undefined) {
                  return yield* protocolError(
                    `OpenCode question request ${requestInput.requestId} requires answers`,
                  );
                }
                const answers = OpenCodeRuntime.toOpenCodeQuestionAnswers(
                  pending.question,
                  requestInput.answers,
                );
                yield* sdkCall(
                  "question.reply",
                  { requestID: pending.nativeRequestId, answers },
                  (signal) =>
                    client.question.reply(
                      {
                        requestID: pending.nativeRequestId,
                        answers,
                      },
                      { signal },
                    ),
                ).pipe(Effect.timeout("10 seconds"));
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* protocolError(
                  `OpenCode approval request ${requestInput.requestId} requires a decision`,
                );
              }
              const reply = OpenCodeRuntime.toOpenCodePermissionReply(requestInput.decision);
              yield* sdkCall(
                "permission.reply",
                { requestID: pending.nativeRequestId, reply },
                (signal) =>
                  client.permission.reply(
                    {
                      requestID: pending.nativeRequestId,
                      reply,
                    },
                    { signal },
                  ),
              ).pipe(Effect.timeout("10 seconds"));
            },
            (effect, requestInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver: OPENCODE_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
                ),
              ),
          ),
          readThreadSnapshot: (snapshotInput) =>
            readSnapshot(snapshotInput.providerThread).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: OPENCODE_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: Effect.fn("OpencodeAdapter.rollbackThread")(
            function* (rollbackInput) {
              const sessionId = nativeThreadId(rollbackInput.providerThread);
              const state = threads.get(sessionId);
              if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot roll back OpenCode thread ${rollbackInput.providerThread.id} while a turn is active`,
                );
              }
              const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
                client.session.messages({ sessionID: sessionId }),
              );
              const messages = unwrapData("session.messages", response);
              let boundaryMessageId: string | undefined;
              if (rollbackInput.target.type === "thread_start") {
                boundaryMessageId = messages.find(({ info }) => info.role === "user")?.info.id;
              } else {
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(
                  rollbackInput.providerThreadTurns,
                  rollbackInput.target.providerTurn.id,
                );
              }
              let retainedThread = rollbackInput.providerThread;
              if (boundaryMessageId !== undefined) {
                const boundaryIndex = messages.findIndex(
                  ({ info }) => info.id === boundaryMessageId,
                );
                if (boundaryIndex < 0)
                  return yield* protocolError(
                    "The OpenCode rewind boundary is no longer available.",
                  );
                const fork = unwrapData(
                  "session.fork",
                  yield* sdkCall(
                    "session.fork",
                    { sessionID: sessionId, messageID: boundaryMessageId },
                    () =>
                      client.session.fork({ sessionID: sessionId, messageID: boundaryMessageId }),
                  ),
                );
                const retained = unwrapData(
                  "session.messages",
                  yield* sdkCall("session.messages", { sessionID: fork.id }, () =>
                    client.session.messages({ sessionID: fork.id }),
                  ),
                );
                if (retained.length !== boundaryIndex)
                  return yield* protocolError(
                    "OpenCode did not preserve the requested rewind boundary.",
                  );
                const installed = openCodeInstalledPermission(input.runtimePolicy, fork.metadata);
                yield* sdkCall("session.update", { sessionID: fork.id }, () =>
                  client.session.update({ sessionID: fork.id, ...installed }),
                );
                retainedThread = {
                  ...rollbackInput.providerThread,
                  nativeThreadRef: providerRef(fork.id),
                };
                // The fork's rules were just replaced without GOAT's deny; the next turn restores it.
                Object.assign(registerThread(fork, retainedThread, state?.appThread ?? null), {
                  ...installed,
                  subagentsDenied: false,
                });
              }
              const snapshot = yield* readSnapshot(retainedThread);
              return {
                ...snapshot,
                providerThread: {
                  ...snapshot.providerThread,
                  nativeConversationHeadRef:
                    rollbackInput.target.type === "provider_turn"
                      ? rollbackInput.target.providerTurn.nativeTurnRef
                      : null,
                },
              };
            },
            (effect, rollbackInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRollbackThreadError({
                      driver: OPENCODE_PROVIDER,
                      providerThreadId: rollbackInput.providerThread.id,
                      checkpointId: rollbackInput.target.checkpointId,
                      cause,
                    }),
                ),
              ),
          ),
          forkThread: Effect.fn("OpencodeAdapter.forkThread")(
            function* (forkInput) {
              const sourceSessionId = nativeThreadId(forkInput.sourceProviderThread);
              const sourceState = threads.get(sourceSessionId);
              if (sourceState?.activeTurn !== null && sourceState?.activeTurn !== undefined) {
                return yield* protocolError(
                  `Cannot fork OpenCode thread ${forkInput.sourceProviderThread.id} while a turn is active`,
                );
              }
              let boundaryMessageId: string | undefined;
              if (forkInput.providerTurnId !== undefined) {
                const sourceTurns = forkInput.sourceProviderTurns ?? [];
                const selected = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
                if (selected === undefined) {
                  return yield* protocolError(
                    `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
                  );
                }
                boundaryMessageId = openCodeBoundaryAfterProviderTurn(sourceTurns, selected.id);
              }
              const response = yield* sdkCall(
                "session.fork",
                {
                  sessionID: sourceSessionId,
                  ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
                },
                () =>
                  client.session.fork({
                    sessionID: sourceSessionId,
                    ...(boundaryMessageId === undefined ? {} : { messageID: boundaryMessageId }),
                  }),
              );
              const nativeSession = unwrapData("session.fork", response);
              const installed = openCodeInstalledPermission(
                forkInput.runtimePolicy ?? input.runtimePolicy,
                nativeSession.metadata,
              );
              yield* sdkCall("session.update", { sessionID: nativeSession.id }, () =>
                client.session.update({ sessionID: nativeSession.id, ...installed }),
              );
              const forkedAt = yield* DateTime.now;
              const providerThread = makeProviderThread({
                idAllocator,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: forkInput.targetThreadId,
                ...(forkInput.ownerNodeId === undefined
                  ? {}
                  : { ownerNodeId: forkInput.ownerNodeId }),
                nativeSession,
                forkedFrom: {
                  providerThreadId: forkInput.sourceProviderThread.id,
                  ...(forkInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: forkInput.providerTurnId }),
                },
                now: forkedAt,
              });
              Object.assign(registerThread(nativeSession, providerThread, null), {
                ...installed,
                subagentsDenied: false,
              });
              return providerThread;
            },
            (effect, forkInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: OPENCODE_PROVIDER,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              ),
          ),
        };

        return runtimeSession;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OPENCODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

export type OpenCodeAdapterV2DriverEnv =
  | OpenCodeRuntime.OpenCodeRuntime
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const OpenCodeAdapterV2Driver: ProviderAdapterDriver<
  OpenCodeSettings,
  OpenCodeAdapterV2DriverEnv
> = {
  driverKind: OPENCODE_PROVIDER,
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => DEFAULT_OPENCODE_SETTINGS,
  create: Effect.fn("OpenCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenCodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const currentEnvironment = makeCurrentLaunchEnvironment(
        input.environment,
        hostEnvironment,
        yield* HostProcess.HomeDirectory,
      );
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      return yield* makeOpenCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* currentEnvironment,
        currentEnvironment,
        ...(providerEventLoggers.native === undefined
          ? {}
          : { nativeEventLogger: providerEventLoggers.native }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OPENCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create OpenCode v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
