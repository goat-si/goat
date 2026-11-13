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
