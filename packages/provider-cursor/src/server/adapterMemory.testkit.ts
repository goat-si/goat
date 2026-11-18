import { EnvironmentId, MemoryId, MemoryRevisionId, MemorySpaceId } from "@goat/contracts";
import { packMemoryContext } from "@goat/provider-core/server/memoryContext";

export function wp4Snapshot() {
  const snapshot = packMemoryContext({
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <instruction> 'data'",
      },
    ],
  });
  if (snapshot === undefined)
    throw new Error("The Cursor memory fixture must produce a context snapshot.");
  return snapshot;
}
