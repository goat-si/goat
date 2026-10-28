export const RECOVERY_WINDOW_MS = 10 * 60_000;
export const MAX_RESTARTS = 5;

export const restartDelayMs = (attempt: number, randomUnit: number): number => {
  const upper = Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt), 5));
  return Math.floor(upper / 2 + (Math.min(1, Math.max(0, randomUnit)) * upper) / 2);
};

export interface RecoveryRecord {
  readonly version: 1;
  readonly attempts: ReadonlyArray<number>;
  readonly attempt: number;
  readonly lastWallTime: number;
  readonly pause: "crash-loop" | "blocked" | "record-unavailable" | null;
  readonly generation: string;
  readonly outcome: string;
}
export const emptyRecoveryRecord = (): RecoveryRecord => ({
  version: 1,
  attempts: [],
  attempt: 0,
  lastWallTime: 0,
  pause: null,
  generation: "",
  outcome: "",
});
export function recordRestart(
  record: RecoveryRecord,
  now: number,
  generation: string,
  outcome: string,
): RecoveryRecord {
  if (record.pause !== null) return record;
  const attempts =
    now < record.lastWallTime
      ? record.attempts
      : record.attempts.filter((at) => now - at < RECOVERY_WINDOW_MS);
  return {
    ...record,
    attempts: attempts.length >= MAX_RESTARTS ? attempts : [...attempts, now],
    attempt: record.attempt + 1,
    lastWallTime: Math.max(now, record.lastWallTime),
    generation,
    outcome: outcome.slice(0, 256),
    pause: attempts.length >= MAX_RESTARTS ? "crash-loop" : null,
  };
}
