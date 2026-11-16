import type {
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
    case "acceptAlways":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  // Codex leaves the legacy `read`/`write` lists out when a path is a glob or
  // special path, and is replacing them with `entries`.
  const requests = (access: "read" | "write") =>
    (permissions.fileSystem?.[access]?.length ?? 0) > 0 ||
    permissions.fileSystem?.entries?.some((entry) => entry.access === access);
  if (requests("write")) {
    return "file-change";
  }
  if (requests("read")) {
    return "file-read";
  }
  return "command";
}

function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
  nativeQuestionIds: ReadonlyMap<string, string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      const nativeId = nativeQuestionIds.get(questionId);
      return nativeId === undefined
        ? []
        : [[nativeId, { answers: [...answerValueToStrings(value)] }]];
    }),
  );
}

export {
  approvalDecisionToLegacyReviewDecision,
  permissionsResponseFromDecision,
  providerRequestKindFromPermissions,
  toCodexUserInputAnswers,
};
