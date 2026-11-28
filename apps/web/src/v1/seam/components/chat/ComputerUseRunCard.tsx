// Seam (lane F): replaces v1 apps/web/src/components/chat/ComputerUseRunCard.tsx @916b5cc. Planned: GOAT 2 has no computer-use runs (Part 2). The row itself still draws the tool line.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { ComputerUseRun } from "@goat/client-runtime/work-log/computer-use";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";

export function ComputerUseRunCard(_props: {
  readonly run: ComputerUseRun;
  readonly status: unknown;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
}) {
  return null;
}
