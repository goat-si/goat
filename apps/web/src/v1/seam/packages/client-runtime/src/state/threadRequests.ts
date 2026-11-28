// Seam (lane F): replaces v1 packages/client-runtime/src/state/threadRequests.ts @916b5cc. v1 threadRequests.ts builds pending requests from v1 thread atoms (entities, runtime). Lifted code imports only the
// two request types below, copied verbatim; GOAT 2 requests come from request.opened lines in the seam (useV1Thread).
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@goat/contracts";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}
