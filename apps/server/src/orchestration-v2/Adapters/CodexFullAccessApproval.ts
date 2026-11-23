import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export function acceptsFullAccessCommand(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: {
    readonly networkApprovalContext?: unknown;
    readonly proposedNetworkPolicyAmendments?: ReadonlyArray<unknown> | null;
  },
): boolean {
  return (
    policy.runtimeMode === "full-access" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined &&
    request.networkApprovalContext == null &&
    (request.proposedNetworkPolicyAmendments ?? []).length === 0
  );
}
