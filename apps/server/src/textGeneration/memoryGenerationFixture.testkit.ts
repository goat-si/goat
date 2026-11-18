import * as M from "@goat/contracts";
import type { ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";

export const memoryFixture = (instanceId: ProviderInstanceId) => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const modelSelection = createModelSelection(instanceId, "pinned-model");
  const sourceThread = {
    environmentId: M.EnvironmentId.make("fixture-owner"),
    threadId: M.ThreadId.make(uuid(1)),
  };
  const sourceWatermark = {
    fromEventId: M.EventId.make(uuid(2)),
    toEventId: M.EventId.make(uuid(3)),
    throughSequence: 7,
  };
  const memorySpaceId = M.MemorySpaceId.make(uuid(4));
  const memoryId = M.MemoryId.make(uuid(5));
  const heads = [6, 7].map((n) => ({
    revision: {
      memorySpaceId,
      memoryId,
      revisionId: M.MemoryRevisionId.make(uuid(n)),
      operationId: M.MemoryOperationId.make(uuid(n + 10)),
      parents: [],
      scope: { kind: "user" as const },
      payloadRef: M.MemoryRevisionId.make(uuid(n)),
      assertionKind: "inference" as const,
      provenance: { environmentId: sourceThread.environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: { text: "ordinary fixture", evidence: [], derivedFromMemoryRevisions: [] },
  }));
  const summary: M.GenerateMemorySummaryInput = {
    cwd: "/isolated-fixture",
    sourceThread,
    sourceWatermark,
    messages: [{ messageId: M.MessageId.make(uuid(8)), text: "ordinary fixture", completed: true }],
    modelSelection,
  };
  const conflict: M.ResolveMemoryConflictInput = {
    cwd: summary.cwd,
    memorySpaceId,
    memoryId,
    conflictId: M.MemoryConflictId.make(uuid(9)),
    heads,
    modelSelection,
  };
  const execution: M.MemoryGenerationExecution = {
    requestedModelSelection: modelSelection,
    effectiveProvider: M.ProviderDriverKind.make("codex"),
    effectiveModel: "effective-alias",
    providerInstanceId: instanceId,
    environmentId: sourceThread.environmentId,
  };
  return { summary, conflict, execution };
};
