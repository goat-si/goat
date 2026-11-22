import type { RemoteReport } from "@goat/contracts";
import type { RemoteWorkerState } from "./ChannelRemoteWorkers.ts";

/** Whether two reads of a task's remote state are the same attempt, on the fields authority uses. */
export const sameAttempt = (expected: RemoteWorkerState, current: RemoteWorkerState | undefined) =>
  current !== undefined &&
  expected.generation === current.generation &&
  expected.host === current.host &&
  expected.cwd === current.cwd &&
  expected.correlationId === current.correlationId &&
  expected.remoteThreadId === current.remoteThreadId &&
  (expected.connection === undefined) === (current.connection === undefined) &&
  expected.connection?.runtimeModeCeiling === current.connection?.runtimeModeCeiling &&
  expected.connection?.memoryGrantCeiling === current.connection?.memoryGrantCeiling;

/** Progress goes first, then the oldest of the rest. */
export const dropOldest = (reports: ReadonlyArray<RemoteReport>, count: number) => {
  const dropped = new Set<number>();
  for (const report of reports) {
    if (dropped.size >= count) break;
    if (report.kind === "progress") dropped.add(report.sequence);
  }
  for (const report of reports) {
    if (dropped.size >= count) break;
    dropped.add(report.sequence);
  }
  return reports.filter((report) => !dropped.has(report.sequence));
};
