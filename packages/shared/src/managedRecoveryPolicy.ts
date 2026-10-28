import type { DesktopBackendHealth } from "@goat/contracts";
export const MANAGED_WATCHDOG_CAPABILITY = "managed-watchdog-health-v1";
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const MAIN_SILENCE_MS = 45_000;
export const STARTUP_GRACE_MS = 30 * 60_000;
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

// This closure is embedded in the standalone worker; keep it free of module dependencies.
export function makeLoopObserver(startedAt: number) {
  let lastTick = startedAt;
  let progressedAt = startedAt;
  let sequence = 0;
  let wasReady = false;
  let graceEnded = false;
  let terminal = false;
  return {
    sample(
      now: number,
      mainSequence: number,
      ready: boolean,
      stopping: boolean,
    ): "healthy" | "startup-slow" | "suspect" | "main-silent" | "stopping" {
      if (terminal) return "main-silent";
      if (now - lastTick > 10_000 || now < lastTick) progressedAt = now;
      lastTick = now;
      if (stopping) return "stopping";
      const progress = mainSequence > sequence;
      if (progress) {
        sequence = mainSequence;
        progressedAt = now;
      }
      if (ready && !wasReady) {
        wasReady = true;
        progressedAt = now;
      }
      if (!wasReady && now - startedAt <= 1_800_000) return "healthy";
      if (!graceEnded) {
        graceEnded = true;
        progressedAt = Math.max(progressedAt, wasReady ? now : startedAt + 1_800_000);
      }
      if (now - progressedAt >= 45_000) {
        terminal = true;
        return "main-silent";
      }
      if (!wasReady) return "startup-slow";
      return now - progressedAt >= 15_000 ? "suspect" : "healthy";
    },
  };
}

export function decodeManagedHealthLine(line: string): DesktopBackendHealth | undefined {
  if (new TextEncoder().encode(line).byteLength > 512) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("type" in value) ||
    value.type !== "backendHealth" ||
    !("generation" in value) ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(value.generation)
  )
    return undefined;
  if (
    !("observerSequence" in value) ||
    typeof value.observerSequence !== "number" ||
    !Number.isSafeInteger(value.observerSequence) ||
    value.observerSequence < 1 ||
    !("mainSequence" in value) ||
    typeof value.mainSequence !== "number" ||
    !Number.isSafeInteger(value.mainSequence) ||
    value.mainSequence < 0
  )
    return undefined;
  if (
    !("phase" in value) ||
    (value.phase !== "starting" &&
      value.phase !== "migrating" &&
      value.phase !== "recovering" &&
      value.phase !== "ready" &&
      value.phase !== "stopping") ||
    !("verdict" in value) ||
    (value.verdict !== "healthy" && value.verdict !== "main-silent")
  )
    return undefined;
  return {
    version: 1,
    type: "backendHealth",
    generation: value.generation,
    observerSequence: value.observerSequence,
    mainSequence: value.mainSequence,
    phase: value.phase,
    verdict: value.verdict,
  };
}

export function makeBackendHealthFramer() {
  const bytes = new Uint8Array(512);
  let length = 0;
  let closed = false;
  return {
    push(chunk: Uint8Array): DesktopBackendHealth[] {
      if (closed) throw new Error("Health channel closed");
      const frames: DesktopBackendHealth[] = [];
      try {
        for (const byte of chunk) {
          if (byte === 10) {
            const frame = decodeManagedHealthLine(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
            );
            if (!frame) throw new Error("Invalid health frame");
            frames.push(frame);
            length = 0;
          } else {
            if (length === bytes.length) throw new Error("Health frame exceeds 512 bytes");
            bytes[length++] = byte;
          }
        }
        return frames;
      } catch (error) {
        closed = true;
        throw error;
      }
    },
    end() {
      if (length !== 0) throw new Error("Incomplete health frame");
      closed = true;
    },
  };
}
