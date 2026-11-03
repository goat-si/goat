const RECOVERY_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;

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
  readonly history?: ReadonlyArray<{ readonly at: number; readonly outcome: string }>;
  readonly notifiedKey?: string;
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
const SLOW_WINDOW_MS = 6 * 60 * 60_000;

export function pruneSlowCrash(record: RecoveryRecord, now: number): RecoveryRecord {
  const history = (record.history ?? []).filter(
    (entry) => entry.at <= now && now - entry.at < SLOW_WINDOW_MS,
  );
  if (history.length >= 4) return { ...record, history };
  const { notifiedKey: _notifiedKey, ...rest } = record;
  return { ...rest, history };
}

function slowCrashKey(
  history: ReadonlyArray<{ readonly at: number; readonly outcome: string }>,
): string | undefined {
  if (history.length < 4) return undefined;
  const counts = new Map<string, number>();
  for (const entry of history) counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  let best: string | undefined;
  let count = 0;
  for (const entry of history) {
    const value = counts.get(entry.outcome) ?? 0;
    if (value >= count) {
      best = entry.outcome;
      count = value;
    }
  }
  return best;
}

export function recordRestart(
  record: RecoveryRecord,
  now: number,
  generation: string,
  outcome: string,
): RecoveryRecord {
  if (record.pause !== null) return record;
  const pruned = pruneSlowCrash(record, now);
  const history = [...(pruned.history ?? []), { at: now, outcome: outcome.slice(0, 64) }].slice(-8);
  const key = slowCrashKey(history);
  const attempts =
    now < record.lastWallTime
      ? record.attempts
      : record.attempts.filter((at) => now - at < RECOVERY_WINDOW_MS);
  return {
    ...pruned,
    history,
    ...(key === undefined ? {} : { notifiedKey: key }),
    attempts: attempts.length >= MAX_RESTARTS ? attempts : [...attempts, now],
    attempt: record.attempt + 1,
    lastWallTime: Math.max(now, record.lastWallTime),
    generation,
    outcome: outcome.slice(0, 256),
    pause: attempts.length >= MAX_RESTARTS ? "crash-loop" : null,
  };
}
