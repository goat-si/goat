import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@goat/contracts";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "@goat/provider-core/server/nativeProtocolLogging";
import { causeErrorTag } from "@goat/shared/observability";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { readableProviderErrorMessage } from "./providerErrorMessage.ts";
import { recordString, recordValue } from "./records.ts";

export const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
export const OPENCODE_SDK_PROTOCOL = "opencode-sdk.sse" as const;

// OpenCode has no turn object; correlate by initiating user message and settle on session idle.
export const OpenCodeProviderCapabilitiesV2 = {
  sessions: {
    // The directory-bound client/server is not safe for cross-thread pooling.
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
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
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: true,
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
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OpenCodeProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly messageKind: "request" | "response" | "notification" | "error";
  readonly method: string;
  readonly payload: unknown;
}

function formatOpenCodeProtocolLogPayload(event: OpenCodeProtocolLogEvent) {
  return {
    direction: event.direction,
    messageKind: event.messageKind,
    method: structuralProtocolMethod(event.method),
    payload: summarizeNativeProtocolPayload(event.payload),
  };
}

export function makeOpenCodeProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
}): (event: OpenCodeProtocolLogEvent) => Effect.Effect<void, never> {
  return (event) =>
    Effect.gen(function* () {
      if (!input.nativeEventLogger || event.method === "message.part.delta") return;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const method = structuralProtocolMethod(event.method);
      yield* input.nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* input.idAllocator.allocate.rawEvent({
              providerSessionId: input.providerSessionId,
              method,
            }),
            kind: "protocol",
            protocol: OPENCODE_SDK_PROTOCOL,
            provider: OPENCODE_PROVIDER,
            providerInstanceId: input.providerInstanceId,
            providerSessionId: input.providerSessionId,
            createdAt: observedAt,
            threadId: input.threadId,
            payload: formatOpenCodeProtocolLogPayload(event),
          },
        },
        input.threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to write native OpenCode event log.", {
              errorTag: causeErrorTag(cause),
              reasonCount: cause.reasons.length,
              provider: OPENCODE_PROVIDER,
              threadId: input.threadId,
            }),
      ),
    );
}

export function sdkResponseForRawLog(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if ("data" in value) return { data: (value as { readonly data?: unknown }).data ?? null };
  if ("stream" in value) return { subscribed: true };
  return value;
}

export function openCodeErrorMessage(
  event: Extract<OpenCodeEvent, { type: "session.error" }>,
): string {
  const error = event.properties.error;
  if (error === undefined) return "OpenCode session failed without an error payload.";
  const statusCode = recordValue(error.data, "statusCode");
  return (
    readableProviderErrorMessage(
      recordString(error.data, "message"),
      typeof statusCode === "number" ? statusCode : undefined,
      recordString(error.data, "responseBody"),
    ) ?? error.name
  );
}

export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

export function unwrapData<A>(operation: string, result: { readonly data?: A }): NonNullable<A> {
  if (result.data === undefined) {
    throw new OpenCodeRuntime.OpenCodeRuntimeError({
      operation,
      detail: `OpenCode ${operation} returned no response payload.`,
    });
  }
  return result.data as NonNullable<A>;
}
