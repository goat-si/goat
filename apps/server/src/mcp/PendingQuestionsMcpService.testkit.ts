import {
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

export const targetId = ThreadId.make("asking");
export const requestId = RuntimeRequestId.make("question");
export const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
const askedQuestions: ReadonlyArray<OrchestrationV2UserInputQuestion> = [
  { id: "q", header: "Choice", question: "Use the existing API?", options: [] },
];
const questionRecords = (
  id: ThreadId,
  rid: RuntimeRequestId,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
) => {
  const request: OrchestrationV2RuntimeRequest = {
    id: rid,
    nodeId: NodeId.make(`node:${rid}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`item:${rid}`),
    type: "user_input_request",
    threadId: id,
    runId: RunId.make("asking-run"),
    nodeId: request.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    requestId: rid,
    questions,
  };
  return { request, item };
};
export const questionProjection = (
  id = targetId,
  rid = requestId,
  questions = askedQuestions,
): OrchestrationV2ThreadProjection => {
  const { request, item } = questionRecords(id, rid, questions);
  return {
    ...idleThreadProjection(liveThreadShell(id)),
    runtimeRequests: [request],
    turnItems: [item],
  };
};
export const approvalProjection = (): OrchestrationV2ThreadProjection => {
  const { request, item } = questionRecords(targetId, requestId, askedQuestions);
  return {
    ...idleThreadProjection(liveThreadShell(targetId)),
    runtimeRequests: [{ ...request, kind: "command" }],
    turnItems: [
      {
        ...item,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "hostname",
      } as OrchestrationV2TurnItem,
    ],
  };
};
