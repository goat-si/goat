import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderApprovalDecision,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
} from "@goat/contracts";
import * as NodeUtil from "node:util";

const CLAUDE_NO_STANDING_GRANT_OPTIONS = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export function claudeApprovalPresentation(input: {
  readonly permissionMode: PermissionMode;
  readonly prompt: string;
  readonly callbackOptions: Pick<
    Parameters<CanUseTool>[2],
    "decisionReason" | "matchedAskRule" | "suppressAlwaysAllowRule"
  >;
}): {
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
} {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = NodeUtil.stripVTControlCharacters(
    input.callbackOptions.decisionReason ?? "",
  ).trim();
  // Bypass auto-allows everything it can, so any ask that still reaches the
  // callback is one bypass refused. The SDK drops the CLI's decision_reason_type,
  // leaving the matched ask rule as the only way to tell the two causes apart.
  const fullAccessOverride: ProviderApprovalFullAccessOverride | undefined =
    input.permissionMode !== "bypassPermissions"
      ? undefined
      : input.callbackOptions.matchedAskRule === undefined
        ? "provider_check"
        : "ask_rule";
  return {
    ...(reason === "" || reason === input.prompt ? {} : { reason }),
    ...(fullAccessOverride === undefined ? {} : { fullAccessOverride }),
    ...(input.callbackOptions.suppressAlwaysAllowRule === true
      ? { options: CLAUDE_NO_STANDING_GRANT_OPTIONS }
      : {}),
  };
}

export function permissionResultFromDecision(input: {
  readonly toolName: string;
  readonly decision: ProviderApprovalDecision;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
  readonly feedback?: string;
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "acceptForSession" ? "user_permanent" : "user_temporary",
      ...(input.decision === "acceptForSession"
        ? {
            updatedPermissions: toSessionPermissionUpdates(input.toolName, input.suggestions),
          }
        : {}),
    };
  }

  return {
    behavior: "deny",
    message:
      input.feedback?.trim() ||
      (input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution."),
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: "session",
  }));
  if (updates.length > 0) {
    return updates;
  }
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}
