import type { ProviderApprovalDecision } from "@goat/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const optionIdOfKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
  if (decision === "acceptForSession") {
    // Agents may offer only allow_once, and answering "cancelled" would stop the turn the user approved.
    return optionIdOfKind("allow_always") ?? optionIdOfKind("allow_once");
  }
  return optionIdOfKind(decision === "accept" ? "allow_once" : "reject_once");
}

// Prefer allow-once; allow-always can persist beyond the session.
export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "accept") ??
    selectPermissionOptionId(request, "acceptForSession")
  );
}
