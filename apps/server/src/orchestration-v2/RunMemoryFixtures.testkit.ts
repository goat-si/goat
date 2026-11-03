import {
  RunId,
  ThreadId,
  ProviderInstanceId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
const memoryNow = DateTime.makeUnsafe("2026-10-15T00:00:00.000Z");
export const memoryRun = (
  index: number,
  fields: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: RunId.make(`memory-run:${index}`),
  threadId: ThreadId.make("memory-thread"),
  ordinal: index,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  providerThreadId: null,
  userMessageId: MessageId.make(`memory-message:${index}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "starting",
  requestedAt: memoryNow,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});
export const memoryMessage = (
  run: OrchestrationV2Run,
  fields: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  id: run.userMessageId,
  threadId: run.threadId,
  runId: run.id,
  nodeId: null,
  role: "user",
  text: "Synthetic",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: memoryNow,
  updatedAt: memoryNow,
  ...fields,
});
