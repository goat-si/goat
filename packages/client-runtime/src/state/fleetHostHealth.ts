import {
  HOST_HISTORY_BUDGET_BYTES,
  MEMORY_STORE_BUDGET_BYTES,
  MEMORY_STORE_TARGET_BYTES,
  type HostStorageHealth,
  type HostStrayProcesses,
  type ServerEventLoopStall,
} from "@goat/contracts";

/**
 * How the Fleet words a host's health. One mapping for every client, so a host reads the same in
 * the console, the graph and on mobile. Each non-healthy state names what is happening, how long
 * it has lasted, the likely cause and one next step; none of them is an open-ended wait.
 */

export type HostHealthTone = "success" | "warning" | "destructive" | "muted";

/** A connection attempt this long stops reading as routine and offers a retry. */
export const SLOW_CONNECT_MS = 30_000;
/** A connected host whose status read has waited this long is not answering. */
export const SLOW_ANSWER_MS = 10_000;
/**
 * History at this share of its budget is approaching it: the host's tooltip says so before it
 * alerts. Memory approaches at MEMORY_STORE_TARGET_BYTES, where its own warning starts.
 */
export const STORAGE_APPROACHING_RATIO = 0.75;
/** History this many times its budget slows the host down. */
export const STORAGE_CRITICAL_RATIO = 3;
/** A reported stall stays the likely cause this long after it happened. */
export const RECENT_STALL_MS = 10 * 60_000;

/** "8s", "1m 12s", "3h 4m", "2d 3h". */
export function formatHealthDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + "h " + (minutes % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

/** Binary units with at most three significant digits: "12 MB", "6.7 GB". */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return Math.round(bytes) + " B";
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 100 ? Math.round(value) : Number(value.toPrecision(2))) + " " + units[unit];
}

export interface HostConnectionWait {
  readonly slow: boolean;
  readonly text: string;
}

/**
 * A connection attempt in progress: "Connecting · 12s · Opening connection", then
 * "Still connecting · 1m 12s · Opening connection" once it is slow.
 */
export function presentConnectionWait(input: {
  readonly step: string | null;
  readonly sinceMs: number;
  readonly nowMs: number;
}): HostConnectionWait {
  const elapsed = Math.max(0, input.nowMs - input.sinceMs);
  const slow = elapsed >= SLOW_CONNECT_MS;
  // The step repeats the state's own word while the attempt has no named step yet.
  const step = input.step === null || /^(re)?connecting$/iu.test(input.step) ? null : input.step;
  return {
    slow,
    text: [slow ? "Still connecting" : "Connecting", formatHealthDuration(elapsed), step]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

export type HostStorageLevel = "ok" | "approaching" | "over" | "critical";

export interface HostStorageMeter {
  readonly bytes: number | null;
  readonly budgetBytes: number;
  /** Null when the size is unknown. */
  readonly ratio: number | null;
}

export interface HostStoragePresentation {
  readonly level: HostStorageLevel;
  readonly tone: HostHealthTone;
  readonly memory: HostStorageMeter;
  readonly history: HostStorageMeter;
  /** "History 6.7 GB of 2 GB · memory 12 MB of 100 MB". */
  readonly summary: string;
  /** The alert sentence when storage needs action; null while within budget. */
  readonly alert: string | null;
  /** What fixes it: history compacts in place; memory is managed in its settings. */
  readonly action: "compact" | "memory_settings" | null;
  /** Elapsed time of a compaction in progress. */
  readonly compactingMs: number | null;
  /** The last compaction's result, in words. */
  readonly lastResult: string | null;
}

const meter = (bytes: number | null, budgetBytes: number): HostStorageMeter => ({
  bytes,
  budgetBytes,
  ratio: bytes === null ? null : bytes / budgetBytes,
});

const levelOf = (ratio: number | null, approachingRatio: number): HostStorageLevel =>
  ratio === null || ratio < approachingRatio
    ? "ok"
    : ratio < 1
      ? "approaching"
      : ratio < STORAGE_CRITICAL_RATIO
        ? "over"
        : "critical";

const LEVEL_ORDER: Record<HostStorageLevel, number> = {
  ok: 0,
  approaching: 1,
  over: 2,
  critical: 3,
};

const sizeOf = (label: string, part: HostStorageMeter) =>
  label +
  " " +
  (part.bytes === null ? "unknown" : formatStorageBytes(part.bytes)) +
  " of " +
  formatStorageBytes(part.budgetBytes);

export function presentHostStorage(
  storage: HostStorageHealth,
  nowMs: number,
): HostStoragePresentation {
  const memory = meter(storage.memoryBytes, MEMORY_STORE_BUDGET_BYTES);
  const history = meter(storage.historyBytes, HOST_HISTORY_BUDGET_BYTES);
  const memoryLevel = levelOf(memory.ratio, MEMORY_STORE_TARGET_BYTES / MEMORY_STORE_BUDGET_BYTES);
  const historyLevel = levelOf(history.ratio, STORAGE_APPROACHING_RATIO);
  const level = LEVEL_ORDER[historyLevel] >= LEVEL_ORDER[memoryLevel] ? historyLevel : memoryLevel;
  const worse = LEVEL_ORDER[historyLevel] >= LEVEL_ORDER[memoryLevel] ? "history" : "memory";
  const compactingMs =
    storage.compactingSince === undefined
      ? null
      : Math.max(0, nowMs - Date.parse(storage.compactingSince));
  let alert: string | null = null;
  if (level === "over" || level === "critical") {
    const part = worse === "history" ? history : memory;
    const times = Math.round((part.ratio ?? 0) * 10) / 10;
    alert =
      (worse === "history" ? "Thread history" : "Memory store") +
      " is " +
      formatStorageBytes(part.bytes ?? 0) +
      ", " +
      (times >= 2 ? times + "× its " : "over its ") +
      formatStorageBytes(part.budgetBytes) +
      " budget" +
      (level === "critical" ? "; this slows GOAT down there" : "");
  }
  const last = storage.lastCompaction;
  let lastResult: string | null = null;
  if (last !== undefined) {
    const removed =
      last.removedEvents === 0
        ? "Nothing old enough to remove"
        : "Removed " + last.removedEvents.toLocaleString("en-US") + " old events";
    lastResult =
      removed +
      (last.freedBytes > 0 ? ", freed " + formatStorageBytes(last.freedBytes) : "") +
      (last.needsOfflineCompaction
        ? "; the file shrinks after goat doctor runs on that machine"
        : "");
  }
  return {
    level,
    tone: level === "critical" ? "destructive" : level === "over" ? "warning" : "muted",
    memory,
    history,
    summary: sizeOf("History", history) + " · " + sizeOf("memory", memory),
    alert,
    action: alert === null ? null : worse === "history" ? "compact" : "memory_settings",
    compactingMs,
    lastResult,
  };
}

export interface HostResponsiveness {
  readonly kind: "not_answering" | "froze";
  /** "Not answering · 18s" or "Froze for 19s". */
  readonly label: string;
  /** The likely cause, from what the host reported last. */
  readonly cause: string;
  readonly tone: HostHealthTone;
  /** Storage is the likely cause, so compacting is the next step. */
  readonly compact: boolean;
}

function likelyCause(
  stall: ServerEventLoopStall | undefined,
  storage: HostStoragePresentation | null,
): { readonly cause: string; readonly compact: boolean } {
  if (storage !== null && (storage.level === "over" || storage.level === "critical")) {
    return {
      cause: (storage.alert ?? storage.summary) + ".",
      compact: storage.action === "compact",
    };
  }
  if (stall?.loadAverage !== undefined && stall.loadAverage > stall.cpuCount) {
    return {
      cause:
        "Its CPU is overloaded (load " +
        Math.round(stall.loadAverage) +
        " on " +
        stall.cpuCount +
        " cores).",
      compact: false,
    };
  }
  return {
    cause: "GOAT there is busy or stalled; its load and storage look normal.",
    compact: false,
  };
}

/**
 * A connected host that answers late. A status read waiting longer than SLOW_ANSWER_MS means it
 * is not answering now; a stall it reported means it froze recently and may again.
 */
export function presentHostResponsiveness(input: {
  /** When the host's current status read started, while it is still waiting. */
  readonly pendingSinceMs: number | null;
  readonly stall: ServerEventLoopStall | undefined;
  readonly storage: HostStoragePresentation | null;
  readonly nowMs: number;
}): HostResponsiveness | null {
  const waited = input.pendingSinceMs === null ? 0 : input.nowMs - input.pendingSinceMs;
  const { cause, compact } = likelyCause(input.stall, input.storage);
  if (waited >= SLOW_ANSWER_MS) {
    return {
      kind: "not_answering",
      label: "Not answering · " + formatHealthDuration(waited),
      cause,
      tone: input.storage?.level === "critical" ? "destructive" : "warning",
      compact,
    };
  }
  const stall = input.stall;
  if (stall !== undefined && input.nowMs - Date.parse(stall.detectedAt) < RECENT_STALL_MS) {
    return {
      kind: "froze",
      label: "Froze for " + formatHealthDuration(stall.durationMs),
      cause,
      tone: "warning",
      compact,
    };
  }
  return null;
}

export interface HostStrayPresentation {
  readonly count: number;
  /** "2 stray GOAT servers · oldest 2d 15h", or "1 stray GOAT server · 2d 15h". */
  readonly detail: string;
  /** One line per process, for the tooltip. */
  readonly lines: ReadonlyArray<string>;
}

export function presentHostStrays(
  strays: HostStrayProcesses | undefined,
  nowMs: number,
): HostStrayPresentation | null {
  if (strays === undefined || strays.processes.length === 0) return null;
  const count = strays.processes.length;
  const oldest = Math.min(...strays.processes.map((process) => Date.parse(process.startedAt)));
  return {
    count,
    detail:
      (count === 1 ? "1 stray GOAT server · " : count + " stray GOAT servers · oldest ") +
      formatHealthDuration(nowMs - oldest),
    lines: strays.processes.map(
      (process) =>
        "PID " +
        process.pid +
        " · " +
        formatHealthDuration(nowMs - Date.parse(process.startedAt)) +
        " · " +
        (process.reason === "home_deleted" ? "home deleted: " : "test home: ") +
        process.baseDir,
    ),
  };
}

/**
 * The host-status failure sentence a client shows. Current servers already send plain sentences;
 * older ones send Node's bare "fetch failed" or a raw code, which this rewords.
 */
export function plainHostFailure(host: string, message: string | undefined): string {
  const text = (message ?? "").trim();
  if (text.length === 0 || text === "host_unavailable" || /\bfetch failed\b/u.test(text)) {
    return "GOAT on " + host + " did not answer; the connection failed before a reply.";
  }
  if (/did not answer .* within \d+s\.?$/u.test(text)) {
    return "GOAT on " + host + " is reachable but too busy to answer in time.";
  }
  return text;
}
