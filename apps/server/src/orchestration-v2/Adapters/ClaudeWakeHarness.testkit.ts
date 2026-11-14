import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeWakeObservations } from "./ClaudeAdapterV2.observations.testkit.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeTestInput.testkit.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

export const makeWakeHarnessWithOptions = (options?: {
  readonly offer?: (message: SDKUserMessage) => Effect.Effect<void>;
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly applyFlagSettings?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"];
  readonly stopTask?: (
    taskId: string,
  ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks?: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly subagentLaunchToolUseId?: string;
  readonly nativeSessionId?: string;
  readonly settings?: ClaudeSettings;
  readonly modelCatalog?: Effect.Effect<ClaudeModelCatalog>;
  readonly freshQueueOnReopen?: boolean;
  readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
  readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
  readonly allocateSessionId?: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const observations = yield* makeWakeObservations;
    const offerAndWait = (message: SDKMessage, offered?: Deferred.Deferred<void>) =>
      observations.offerAndWait(processQueues.at(-1) ?? sdkMessages, message, offered);
    const offeredMessages: Array<SDKUserMessage> = [];
    const permissionModeChanges: Array<string> = [];
    const liveSelectionChanges: Array<unknown> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const continuationReceipts =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const terminalReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    const subagentReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
      >();
    const systemNoticeReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
      >();
    const runtimeRequestReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      >();
    const planReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
      >();
    const providerThreadReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
      >();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      ...(options?.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          observations
            .observe(() => {
              continuationRequests.push(request);
            })
            .pipe(Effect.andThen(Queue.offer(continuationReceipts, request))),
      },
      queryRunner: {
        allocateSessionId:
          options?.allocateSessionId ??
          Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              const processMessages = yield* Queue.unbounded<SDKMessage>();
              processQueues.push(processMessages);
              return {
                messages: observations.messages(processMessages),
                offer: (message: SDKUserMessage) =>
                  observations.observe(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: (mode) =>
                  observations
                    .observe(() => {
                      permissionModeChanges.push(mode);
                    })
                    .pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
            return {
              messages: observations.messages(sdkMessages),
              offer: (message) =>
                (options?.offer?.(message) ?? Effect.void).pipe(
                  Effect.andThen(
                    observations.observe(() => {
                      offeredMessages.push(message);
                    }),
                  ),
                ),
              setModel: (model) =>
                Effect.sync(() => {
                  liveSelectionChanges.push({ model });
                }),
              applyFlagSettings: (settings) =>
                Effect.sync(() => {
                  liveSelectionChanges.push(settings);
                }).pipe(
                  Effect.andThen(() => options?.applyFlagSettings?.(settings) ?? Effect.void),
                ),
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
              backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
              stopTask: options?.stopTask ?? (() => Effect.void),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
        subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* observations
      .collectEvents(runtime.events, (event) =>
        Effect.gen(function* () {
          yield* observations.observe(() => {
            events.push(event);
          });
          if (event.type === "subagent.updated") {
            yield* Queue.offer(subagentReceipts, event);
          }
          if (event.type === "runtime_request.updated")
            yield* Queue.offer(runtimeRequestReceipts, event);
          if (event.type === "plan.updated") yield* Queue.offer(planReceipts, event);
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "provider_thread.updated") {
            yield* Queue.offer(providerThreadReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
        }),
      )
      .pipe(Effect.forkScoped);
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      ...observations,
      attachmentsDir,
      runtimeRequestReceipts,
      planReceipts,
      awaitTerminal: (count: number) =>
        observations.awaitUntil(() => terminalEvents().length >= count, "terminal events recorded"),
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      processQueues,
      offerAndWait,
      offeredMessages,
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      liveSelectionChanges,
      continuationRequests,
      continuationReceipts,
      events,
      terminalReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      providerThreadReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
    };
  });
