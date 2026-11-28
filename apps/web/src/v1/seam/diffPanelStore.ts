// Seam (lane F): replaces v1 apps/web/src/diffPanelStore.ts @916b5cc. v1 diffPanelStore.ts is the persisted diff panel store; GOAT 2 has no diff panel (Part 2). Lifted code imports
// only these types, copied verbatim; the timeline gets onOpenTurnDiff undefined, so no row opens a diff.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { RunId, ThreadId, TurnItemId } from "@goat/contracts";

/** A tool call whose own patch the server holds, read with getTurnItem. */
export interface DiffPanelSourceItem {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}

/** Opens a turn's diff, or the edit's own patch when the server holds one. */
export type OpenTurnDiff = (
  runId: RunId,
  filePath?: string,
  sourceItem?: DiffPanelSourceItem,
) => void;
