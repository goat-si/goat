import * as M from "@goat/contracts";

export const moveFloorCapabilities = {
  protocolVersion: 1,
  refusedReverts: true,
  resolutionInputs: true,
  retainedLocalSpace: true,
  provenanceProjection: true,
  derivedCap: 1000,
  conversationMemoryControl: true,
  turnMemory: true,
  savedThreadPreference: true,
  originFilter: true,
  originUpdates: true,
  originCatchup: true,
  scopeMoves: true,
  scopeMoveReceipts: true,
  saveSuggestions: true,
  mutationFailureDetails: true,
  generationHold: true,
  hubDiagnostics: true,
  siteNotes: true,
} as const;

export function availableSourceReply(
  request: M.MemoryHubSourceReadRequestInput,
  messageId: M.MessageId,
): M.MemoryHubSourceReadRespondInput {
  return {
    protocolVersion: 1,
    kind: "normal",
    features: M.MEMORY_FLOOR_2,
    memorySpaceId: request.memorySpaceId,
    requestId: request.requestId,
    ownerPolicyEpoch: 1,
    outcome: {
      kind: "available",
      page: {
        sourceThread: request.sourceThread,
        watermark: request.sourceWatermark,
        messages: [{ messageId, text: "synthetic original" }],
        nextCursor: null,
      },
    },
  };
}
