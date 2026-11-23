import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
} from "@goat/contracts";
import type * as Deferred from "effect/Deferred";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";

export class AcpModelSelectionError extends Schema.TaggedError<AcpModelSelectionError>()(
  "AcpModelSelectionError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The agent did not accept the model "${this.model}". Choose another model for this provider, then retry.`;
  }
}

export interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  sourceMessageId: string | null;
  text: string;
  // The running node and first text have been emitted.
  emitted: boolean;
  // Text changed since the last emission; a delayed flush is scheduled.
  dirty: boolean;
}

export interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
  /** Closed messages a later chunk can resume, oldest first, up to MAX_RESUMABLE_TEXT_SEGMENTS. */
  readonly closedNamedSegments: Map<string, ActiveTextSegment>;
}

export interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export const ACP_STOP_CONFIRM_TIMEOUT_MS = 10_000;

export type PendingRuntimeRequest = {
  readonly generation: number;
  readonly nativeResponseAcknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
  readonly transportRequestId: string;
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
} & (
  | {
      readonly type: "approval";
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers | null>;
    }
);

export type AcpRuntimeTeardownState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "InProgress";
      readonly completed: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
    }
  | { readonly _tag: "Failed"; readonly error: ProviderAdapter.ProviderAdapterProtocolError };
