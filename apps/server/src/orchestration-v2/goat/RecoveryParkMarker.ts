import { TurnItemId, type RunId } from "@goat/contracts";

export const RECOVERY_PARK_MARKER_PREFIX = "turn-item:recovery-parked:";
export const recoveryParkMarkerId = (runId: RunId) =>
  TurnItemId.make(`${RECOVERY_PARK_MARKER_PREFIX}${runId}`);
