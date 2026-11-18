import {
  MemoryPage,
  MemorySuggestionAcceptResult,
  MemorySuggestionDismissResult,
  MemorySuggestionList,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export const legacyMemoryCapabilities = { protocolVersion: 1 } as const;
export const suggestionMemoryCapabilities = {
  ...legacyMemoryCapabilities,
  saveSuggestions: true,
  provenanceProjection: true,
} as const;

// Recorded from the save-suggestion and hub services against a synthetic in-memory store.
export const suggestionScenario = Schema.decodeSync(
  Schema.Struct({
    refused: MemorySuggestionList,
    accept: MemorySuggestionAcceptResult,
    accepting: MemorySuggestionList,
    unpublished: MemoryPage,
    published: MemoryPage,
    settled: MemorySuggestionList,
    legacyPage: MemoryPage,
    dismissible: MemorySuggestionList,
    dismiss: MemorySuggestionDismissResult,
    dismissed: MemorySuggestionList,
    forgettable: MemorySuggestionList,
    forgotten: MemorySuggestionList,
    afterForget: MemoryPage,
  }),
)({
  refused: [
    {
      suggestionId: "00000000-0000-4000-8000-000000000115",
      origin: {
        environmentId: "hub",
        threadId: "synthetic-source-thread",
      },
      scope: {
        kind: "user",
      },
      lineageComplete: false,
      reason: "thread_lineage_incomplete",
      state: "pending",
      expiresAt: 1795627276285,
      text: "Synthetic words to review",
    },
  ],
  accept: {
    status: "pending",
  },
  accepting: [
    {
      suggestionId: "00000000-0000-4000-8000-000000000115",
      origin: {
        environmentId: "hub",
        threadId: "synthetic-source-thread",
      },
      scope: {
        kind: "user",
      },
      lineageComplete: false,
      reason: "thread_lineage_incomplete",
      state: "accepting",
      expiresAt: 1795627276285,
      text: "Synthetic words to review",
    },
  ],
  unpublished: {
    items: [],
    projectionWatermark: 0,
    nextCursor: null,
  },
  published: {
    items: [
      {
        marks: {
          provenance: "unverified",
          originThreadId: "synthetic-source-thread",
        },
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        memoryId: "00000000-0000-4000-8000-000000000115",
        pendingSync: false,
        localAvailability: {
          exposure: "visible",
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
        status: "active",
        scope: {
          kind: "user",
        },
        revision: {
          memorySpaceId: "00000000-0000-4000-8000-000000000001",
          memoryId: "00000000-0000-4000-8000-000000000115",
          revisionId: "167882d4-bcbe-4d91-856f-6f9f0d8e1503",
          operationId: "a7cf3172-3f86-4437-82ea-dd8d40fb35d0",
          parents: [],
          scope: {
            kind: "user",
          },
          payloadRef: "167882d4-bcbe-4d91-856f-6f9f0d8e1503",
          assertionKind: "inference",
          provenance: {
            environmentId: "hub",
            upsertRequestDigest: "c12aa30db31cbe6c83d64edb1a0cb0dee13167ef0b059e61572f194d9c09cd10",
          },
          createdAtUtc: "2026-11-18T17:21:16.289Z",
        },
        payload: {
          text: "Synthetic words to review",
          evidence: [],
          derivedFromMemoryRevisions: [],
        },
      },
    ],
    projectionWatermark: 1,
    nextCursor: null,
  },
  settled: [],
  legacyPage: {
    items: [
      {
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        memoryId: "00000000-0000-4000-8000-000000000115",
        pendingSync: false,
        localAvailability: {
          exposure: "visible",
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
        status: "active",
        scope: {
          kind: "user",
        },
        revision: {
          memorySpaceId: "00000000-0000-4000-8000-000000000001",
          memoryId: "00000000-0000-4000-8000-000000000115",
          revisionId: "167882d4-bcbe-4d91-856f-6f9f0d8e1503",
          operationId: "a7cf3172-3f86-4437-82ea-dd8d40fb35d0",
          parents: [],
          scope: {
            kind: "user",
          },
          payloadRef: "167882d4-bcbe-4d91-856f-6f9f0d8e1503",
          assertionKind: "inference",
          provenance: {
            environmentId: "hub",
            upsertRequestDigest: "c12aa30db31cbe6c83d64edb1a0cb0dee13167ef0b059e61572f194d9c09cd10",
          },
          createdAtUtc: "2026-11-18T17:21:16.289Z",
        },
        payload: {
          text: "Synthetic words to review",
          evidence: [],
          derivedFromMemoryRevisions: [],
        },
      },
    ],
    projectionWatermark: 1,
    nextCursor: null,
  },
  dismissible: [
    {
      suggestionId: "00000000-0000-4000-8000-000000000116",
      origin: {
        environmentId: "hub",
        threadId: "synthetic-source-thread",
      },
      scope: {
        kind: "user",
      },
      lineageComplete: false,
      reason: "thread_lineage_incomplete",
      state: "pending",
      expiresAt: 1795627276330,
      text: "Synthetic words to dismiss",
    },
  ],
  dismiss: {
    ok: true,
  },
  dismissed: [],
  forgettable: [
    {
      suggestionId: "00000000-0000-4000-8000-000000000117",
      origin: {
        environmentId: "hub",
        threadId: "synthetic-source-thread",
      },
      scope: {
        kind: "user",
      },
      lineageComplete: false,
      reason: "thread_lineage_incomplete",
      state: "pending",
      expiresAt: 1795627276331,
      text: "Synthetic words to forget",
    },
  ],
  forgotten: [],
  afterForget: {
    items: [
      {
        marks: {
          originThreadId: "synthetic-source-thread",
        },
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        memoryId: "00000000-0000-4000-8000-000000000115",
        pendingSync: true,
        localAvailability: {
          exposure: "forgotten",
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
        status: "forgotten",
        tombstone: {
          memorySpaceId: "00000000-0000-4000-8000-000000000001",
          memoryId: "00000000-0000-4000-8000-000000000115",
          deleteOperationId: "00000000-0000-4000-8000-000000000085",
          deletingEnvironmentId: "hub",
          deletedAtUtc: "2026-11-18T17:21:16.333Z",
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      },
    ],
    projectionWatermark: 2,
    nextCursor: null,
  },
});
