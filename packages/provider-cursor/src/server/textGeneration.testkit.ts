import { assert } from "@effect/vitest";
import * as M from "@goat/contracts";
import { ProviderInstanceId, type TextGenerationError } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeCursorTextGeneration } from "./textGeneration.ts";

export const memorySelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("cursor"),
  model: "auto",
  options: [],
});

export const memoryContext = {
  providerInstanceId: memorySelection.instanceId,
  environmentId: M.EnvironmentId.make("memory-owner"),
};

const memoryId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const memoryRevision = M.MemoryRevision.make({
  memorySpaceId: M.MemorySpaceId.make(memoryId(1)),
  memoryId: M.MemoryId.make(memoryId(2)),
  revisionId: M.MemoryRevisionId.make(memoryId(3)),
  payloadRef: M.MemoryRevisionId.make(memoryId(3)),
  operationId: M.MemoryOperationId.make(memoryId(4)),
  parents: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  provenance: { environmentId: memoryContext.environmentId },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
});

const memoryPayload = M.MemoryPayload.make({
  text: "Synthetic input",
  evidence: [],
  derivedFromMemoryRevisions: [],
});

const memorySummary = M.GenerateMemorySummaryInput.make({
  cwd: "/synthetic-checkout",
  sourceThread: {
    environmentId: memoryContext.environmentId,
    threadId: M.ThreadId.make("synthetic-thread"),
  },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic input", completed: true }],
  modelSelection: memorySelection,
});

const memoryConflict = M.ResolveMemoryConflictInput.make({
  cwd: memorySummary.cwd,
  memorySpaceId: memoryRevision.memorySpaceId,
  memoryId: memoryRevision.memoryId,
  conflictId: M.MemoryConflictId.make(memoryId(8)),
  heads: [
    { revision: memoryRevision, payload: memoryPayload },
    {
      revision: {
        ...memoryRevision,
        revisionId: M.MemoryRevisionId.make(memoryId(5)),
        payloadRef: M.MemoryRevisionId.make(memoryId(5)),
      },
      payload: memoryPayload,
    },
  ],
  modelSelection: memorySelection,
});

export const memoryOutput = { text: "Synthetic result", assertionKind: "inference", evidence: [] };

export const memoryOperations = ["resolveMemoryConflict", "generateMemorySummary"] as const;

export const runMemory = (
  generation: Effect.Success<ReturnType<typeof makeCursorTextGeneration>>,
  operation: (typeof memoryOperations)[number],
  selection = memorySelection,
): Effect.Effect<
  {
    readonly result: { readonly text: string } | null;
    readonly execution: M.MemoryGenerationExecution;
  },
  TextGenerationError
> => {
  if (operation === "resolveMemoryConflict") {
    assert.isDefined(generation.resolveMemoryConflict);
    return generation.resolveMemoryConflict({ ...memoryConflict, modelSelection: selection });
  }
  assert.isDefined(generation.generateMemorySummary);
  return generation.generateMemorySummary({ ...memorySummary, modelSelection: selection });
};

export const decodeToolPolicy = Schema.decodeUnknownSync(
  Schema.Struct({ tools: Schema.Array(Schema.String) }),
);

export const commitMessageRequest = {
  cwd: "/fixture/project",
  branch: "test",
  stagedSummary: "M file",
  stagedPatch: "diff",
  modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
};
