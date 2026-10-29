import { poolError } from "./device.ts";
import { failedChecks, type PoseResult } from "./report.ts";

/**
 * Runs a pose, retrying up to twice when an attempt failed in a way a new device can fix. An
 * attempt that already recorded an app failure is final: a retry would replace that evidence.
 */
export async function attemptPose(
  attempt: (session: string) => Promise<PoseResult>,
  runId: string,
  onRetry: (error: string) => void,
): Promise<PoseResult> {
  let result = await attempt(runId);
  for (let retry = 1; retry <= 2; retry++) {
    const error = result.error;
    if (error === undefined || failedChecks(result).length > 0) break;
    // A pose that failed before its first screen usually met the pool, not the app.
    if (result.steps.length > 0 && !poolError(error)) break;
    onRetry(error);
    result = await attempt(`${runId}-retry${retry}`);
  }
  return result;
}
