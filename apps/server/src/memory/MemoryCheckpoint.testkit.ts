/** Structurally valid ledger data for SQL quota fixtures; no approval/history is invented. */
export const checkpointLedgerFixture = (
  memorySpaceId: string,
  memoryId: string,
  creatingEnvironmentId: string,
) => ({
  identity: JSON.stringify({
    memorySpaceId,
    memoryId,
    scope: { kind: "user" },
    creatingEnvironmentId,
    createOperationId: "00000000-0000-4000-8000-000000000001",
    createdAtUtc: "1970-01-01T00:00:00.000Z",
  }),
  fence: JSON.stringify({ memorySpaceId, memoryId, highestFencingToken: 0, activeLease: null }),
});
