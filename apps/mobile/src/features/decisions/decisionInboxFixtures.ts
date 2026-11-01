import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { ThreadUserInputQuestion } from "@goat/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";

export const envA = EnvironmentId.make("A");
export const envB = EnvironmentId.make("B");
export const requestId = RuntimeRequestId.make("same-request");
export const question: ThreadUserInputQuestion = {
  id: "q",
  header: "Choice",
  question: "Choose an answer",
  multiSelect: true,
  allowCustomAnswer: true,
  options: [
    { value: "one", label: "One", description: "First" },
    { value: "two", label: "Two", description: "Second" },
  ],
};
export function approval(
  environmentId = envA,
  threadId = ThreadId.make("thread"),
  date = "2026-10-01T00:00:00.000Z",
): Extract<DecisionItem, { kind: "approval" }> {
  return {
    id: JSON.stringify([environmentId, threadId, requestId]),
    ref: { environmentId, threadId },
    createdAt: date,
    routing: { routedTo: "person" },
    kind: "approval",
    request: { requestId, createdAt: date, requestKind: "command", responseCapability: "live" },
  };
}
export function userInput(
  environmentId = envA,
  questions: readonly ThreadUserInputQuestion[] = [question],
  threadId = ThreadId.make("thread"),
): Extract<DecisionItem, { kind: "user_input" }> {
  const base = approval(
    environmentId,
    threadId,
    environmentId === envA ? "2026-10-01T00:00:00.000Z" : "2026-10-02T00:00:00.000Z",
  );
  return {
    ...base,
    kind: "user_input",
    request: {
      requestId,
      createdAt: base.createdAt,
      questions,
      dismissible: true,
      responseCapability: "message",
    },
  };
}
export function durable(): Extract<DecisionItem, { kind: "decision" }> {
  const base = approval();
  return {
    ...base,
    id: JSON.stringify(["decision", envA, "decision:1"]),
    kind: "decision",
    decision: {
      id: "decision:1",
      source: "decision",
      from: { threadId: base.ref.threadId },
      title: "Which database?",
      context: "",
      options: [
        { id: "sqlite", label: "SQLite", consequence: "No new server" },
        { id: "pg", label: "Postgres", consequence: "Needs a server" },
      ],
      recommended: "sqlite",
      requiredProfile: "default",
      expiresAt: null,
      status: "open",
      answer: null,
      answeredBy: null,
      createdAt: base.createdAt,
      updatedAt: base.createdAt,
      humanRequired: false,
    },
  };
}
