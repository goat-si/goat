import * as M from "@goat/contracts";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import type { MemoryContextSnapshot } from "@goat/contracts";
import { buildCodexTurnStartParams } from "./CodexTurnStartParams.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";

export const queuedMemoryParams = (
  nativeThreadId: string,
  prompt: string,
  memoryContext: MemoryContextSnapshot,
) =>
  buildCodexTurnStartParams({
    nativeThreadId,
    codexInput: [{ type: "text", text: prompt }],
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    memoryContext,
  });

export const wp4Memory = () => {
  const snapshot = MemoryContext.packMemoryContext({
    memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: M.MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: M.MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: M.EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <untrusted> 'quoted' \"data\"",
      },
    ],
  });
  if (!snapshot) throw new Error("fixture memory could not be packed");
  return snapshot;
};
