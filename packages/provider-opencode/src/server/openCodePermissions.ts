import type { ProviderApprovalDecision, RuntimeMode } from "@goat/contracts";
import {
  type PermissionRuleset,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }

  // OpenCode has no AI reviewer; Auto falls back to Supervised.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}
