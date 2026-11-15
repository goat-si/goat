import type { OrchestrationV2UserInputQuestion, ProviderApprovalDecision } from "@goat/contracts";

import { piRecordString as recordString, type PiRpcRecord } from "./rpc.ts";

export function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  // Pi's select and editor dialogs carry only a title, so show it once, as the question.
  // Extensions may send a blank placeholder, which is not a valid question.
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

export function piUiResponse(
  pending: {
    readonly method: "select" | "confirm" | "input" | "editor";
    readonly questionId: string;
  },
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  // RPC distinguishes empty dialog values from cancellation (undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}
