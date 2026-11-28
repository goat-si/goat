// Seam (lane F): replaces v1 apps/web/src/components/chat/FileChangeInlineDiff.tsx @916b5cc. Planned (Part 2: diffs by engine locator). The row renders it only when onOpenTurnDiff is set, which GOAT 2 leaves
// undefined, so this never draws today.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { OrchestrationV2ProjectedTurnItem, RunId, ScopedThreadRef } from "@goat/contracts";
import type { OpenTurnDiff } from "../../diffPanelStore.ts";

export function FileChangeInlineDiff(_props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly runId: RunId;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenTurnDiff: OpenTurnDiff;
}) {
  return null;
}
