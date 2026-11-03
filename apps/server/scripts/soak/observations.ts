// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeStringDecoder from "node:string_decoder";

export type Coverage = "complete" | "partial" | "unknown";
export type Counter = {
  value: number | null;
  observed: number;
  coverage: Coverage;
  reasons: string[];
  evidence: string[];
};
export function counter(observed = 0, reasons: string[] = []): Counter {
  return {
    value: reasons.length ? null : observed,
    observed,
    coverage: reasons.length ? "unknown" : "complete",
    reasons,
    evidence: [],
  };
}

const LIMIT = 100_000;
const MAX_LINE = 1024 * 1024;
type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

export function cpuBusy(previous: readonly CpuTimes[], current: readonly CpuTimes[]): number[] {
  if (previous.length !== current.length || current.length === 0) return [];
  return current.map((now, index) => {
    const before = previous[index];
    if (!before) return NaN;
    const total = (Object.keys(now) as Array<keyof CpuTimes>).reduce(
      (sum, key) => sum + now[key] - before[key],
      0,
    );
    const idle = now.idle - before.idle;
    return total > 0 && idle >= 0 && idle <= total ? (100 * (total - idle)) / total : NaN;
  });
}

export function saturation(
  samples: readonly { at: string; perCore: number[]; busy: number }[],
  gaps: readonly string[],
) {
  const values = samples.map((sample) => sample.busy);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return {
      verified: false,
      min: null,
      avg: null,
      p10: null,
      samples,
      gaps: [...gaps, "invalid or missing CPU samples"],
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? null;
  return {
    verified: gaps.length === 0 && avg >= 90 && p10 !== null && p10 >= 80,
    min,
    avg,
    p10,
    samples,
    gaps: [...gaps],
  };
}
export class LogTail {
  readonly path: string;
  private readonly consume: (value: unknown) => void;
  private offset = 0;
  private identity: string | undefined;
  private partial = "";
  private decoder = new NodeStringDecoder.StringDecoder("utf8");
  readonly gaps: string[] = [];
  constructor(path: string, consume: (value: unknown) => void) {
    this.path = path;
    this.consume = consume;
  }
  startAtEnd(): void {
    try {
      const stat = NodeFS.statSync(this.path);
      this.identity = `${stat.dev}:${stat.ino}`;
      this.offset = stat.size;
    } catch (error) {
      this.gap(`initial offset failed: ${String(error)}`);
    }
  }
  read(): void {
    let fd: number | undefined;
    try {
      fd = NodeFS.openSync(this.path, "r");
      const stat = NodeFS.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== undefined && (identity !== this.identity || stat.size < this.offset)) {
        this.gap("file rotated or truncated");
        this.offset = 0;
        this.partial = "";
        this.decoder = new NodeStringDecoder.StringDecoder("utf8");
      }
      this.identity = identity;
      const buffer = Buffer.alloc(64 * 1024);
      let n: number;
      while ((n = NodeFS.readSync(fd, buffer, 0, buffer.length, this.offset)) > 0) {
        this.offset += n;
        this.partial += this.decoder.write(buffer.subarray(0, n));
        let newline: number;
        while ((newline = this.partial.indexOf("\n")) >= 0) {
          const line = this.partial.slice(0, newline);
          this.partial = this.partial.slice(newline + 1);
          if (line.length > MAX_LINE) {
            this.gap("line exceeds limit");
            continue;
          }
          try {
            this.consume(JSON.parse(line));
          } catch {
            this.gap("invalid line or consumer failure");
          }
        }
        if (this.partial.length > MAX_LINE) {
          this.gap("partial line exceeds limit");
          this.partial = "";
        }
      }
    } catch (error) {
      this.gap(`read failed: ${String(error)}`);
    } finally {
      if (fd !== undefined) NodeFS.closeSync(fd);
    }
  }
  get hasPartialLine(): boolean {
    return this.partial.length > 0;
  }
  private gap(reason: string) {
    if (!this.gaps.includes(reason)) this.gaps.push(reason);
  }
}

export class DetailWriter {
  private readonly fd: number;
  constructor(path: string) {
    this.fd = NodeFS.openSync(path, "wx", 0o600);
  }
  write(value: unknown): void {
    NodeFS.writeSync(this.fd, `${JSON.stringify(value)}\n`);
  }
  close(): void {
    NodeFS.closeSync(this.fd);
  }
}

type Lifecycle = {
  event: "start" | "session" | "exit";
  pid: number;
  instance: string;
  at: string;
  thread?: string;
};
type Release = { thread: string; at: string; status: "stopped" | "error" };
type Death = { thread: string; instance: string; at: string };
export function providerRestarts(
  lines: Lifecycle[],
  joins: Map<string, string>,
  releases: Release[],
  deaths: Death[],
  coverageReasons: string[],
): {
  counter: Counter;
  replayExtraPids: number;
  codexExtraPids: number;
  processExitEpisodes: number;
  subtractedStoppedReleases: number;
} {
  const starts = lines.filter((line) => line.event === "start");
  const sessions = lines.filter((line) => line.event === "session");
  const groups = new Map<string, Array<Lifecycle>>();
  const reasons = [...coverageReasons];
  for (const start of starts) {
    const native = sessions
      .filter((entry) => entry.pid === start.pid && entry.instance === start.instance)
      .map((entry) => entry.thread)
      .filter((thread): thread is string => thread !== undefined);
    const threads =
      start.instance === "devReplay"
        ? [
            ...new Set(
              native.map((id) => joins.get(id)).filter((id): id is string => id !== undefined),
            ),
          ]
        : [start.instance];
    if (start.instance === "devReplay" && threads.length !== 1) {
      reasons.push(`unjoined replay pid ${start.pid}`);
      continue;
    }
    for (const thread of threads) {
      const key = `${start.instance === "devReplay" ? "replay" : "codex"}:${thread}`;
      const group = groups.get(key) ?? [];
      if (!group.some((entry) => entry.pid === start.pid)) group.push(start);
      groups.set(key, group);
    }
  }
  let replayExtraPids = 0,
    codexExtraPids = 0,
    processExitEpisodes = 0,
    subtractedStoppedReleases = 0;
  const matchedDeaths = new Set<number>();
  for (const [key, group] of groups) {
    group.sort((a, b) => a.at.localeCompare(b.at));
    const name = key.slice(key.indexOf(":") + 1);
    for (let i = 1; i < group.length; i++) {
      const previous = group[i - 1];
      const current = group[i];
      if (previous === undefined || current === undefined) continue;
      if (
        key.startsWith("codex:") &&
        releases.some((r) => r.status === "stopped" && r.at >= previous.at && r.at < current.at)
      ) {
        reasons.push("Codex stopped releases need instance/session coverage");
      }
      const stopped =
        key.startsWith("replay:") &&
        releases.some(
          (r) =>
            r.thread === name && r.status === "stopped" && r.at >= previous.at && r.at < current.at,
        );
      if (stopped) {
        subtractedStoppedReleases++;
        continue;
      }
      if (key.startsWith("replay:")) replayExtraPids++;
      else codexExtraPids++;
      const index = deaths.findIndex(
        (death, n) =>
          !matchedDeaths.has(n) &&
          (key.startsWith("replay:") ? death.thread === name : death.instance === name) &&
          death.at >= previous.at &&
          death.at < current.at,
      );
      if (index >= 0) matchedDeaths.add(index);
    }
  }
  processExitEpisodes = deaths.length - matchedDeaths.size;
  if ([lines.length, releases.length, deaths.length].some((n) => n >= LIMIT))
    reasons.push("observation limit reached");
  return {
    counter: counter(replayExtraPids + codexExtraPids + processExitEpisodes, [...new Set(reasons)]),
    replayExtraPids,
    codexExtraPids,
    processExitEpisodes,
    subtractedStoppedReleases,
  };
}

export class Observations {
  readonly lifecycle: Lifecycle[] = [];
  readonly joins = new Map<string, string>();
  readonly releases: Release[] = [];
  readonly deaths: Death[] = [];
  private deathRuns = new Set<string>();
  private socketEpisodes = new Set<string>();
  private runs = new Map<string, "pending" | "completed" | "failed" | "interrupted">();
  private windowOpen = false;
  private completedInWindow = 0;
  private completedDuringDrain = 0;
  readonly gaps: string[] = [];
  readonly stall = {
    runtimeMaxMs: null as number | null,
    startupMaxMs: null as number | null,
    samples: 0,
    droppedRecords: 0,
  };
  readonly trace = { retired: 0 };
  consumeLifecycle(value: unknown): void {
    if (typeof value !== "object" || value === null) throw new Error("invalid lifecycle record");
    const line = value as Record<string, unknown>;
    if (
      (line.event !== "start" && line.event !== "session" && line.event !== "exit") ||
      typeof line.pid !== "number" ||
      typeof line.instance !== "string" ||
      typeof line.at !== "string" ||
      (line.event === "session" && typeof line.thread !== "string")
    )
      throw new Error("invalid lifecycle record");
    if (this.lifecycle.length >= LIMIT) this.gap("lifecycle observation limit reached");
    else this.lifecycle.push(line as Lifecycle);
  }
  joinProvider(native: string, thread: string): void {
    const existing = this.joins.get(native);
    if (existing && existing !== thread) this.gap(`ambiguous native thread ${native}`);
    else this.joins.set(native, thread);
  }
  releaseProvider(thread: string, at: string, status: "stopped" | "error"): void {
    if (this.releases.length >= LIMIT) this.gap("release observation limit reached");
    else this.releases.push({ thread, at, status });
  }
  providerDeath(run: string, thread: string, instance: string, at: string): void {
    if (this.deathRuns.has(run)) return;
    if (this.deaths.length >= LIMIT) this.gap("death observation limit reached");
    else {
      this.deathRuns.add(run);
      this.deaths.push({ thread, instance, at });
    }
  }
  consumeTrace(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.gap("invalid trace record");
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.event === "provider.runtime.retired" ||
      record.message === "provider.runtime.retired"
    ) {
      this.trace.retired++;
    }
  }
  recordSocket(id: string, requested: boolean): void {
    if (!requested) this.add(this.socketEpisodes, id);
  }
  issueRun(id: string): void {
    if (this.runs.size >= LIMIT) this.gap("run limit reached");
    else if (!this.runs.has(id)) this.runs.set(id, "pending");
  }
  setWindowOpen(open: boolean): void {
    this.windowOpen = open;
  }
  recordRun(id: string, status: "completed" | "failed" | "interrupted"): void {
    if (this.runs.get(id) !== "pending") return;
    this.runs.set(id, status);
    if (status === "completed") {
      if (this.windowOpen) this.completedInWindow++;
      else this.completedDuringDrain++;
    }
  }
  consumeStall(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.gap("invalid stall record");
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.delayMaxMs !== "number" || typeof record.droppedStallRecords !== "number") {
      this.gap("invalid stall record");
      return;
    }
    this.stall.samples++;
    this.stall.droppedRecords = Math.max(this.stall.droppedRecords, record.droppedStallRecords);
    const field = record.phase === "startup" ? "startupMaxMs" : "runtimeMaxMs";
    this.stall[field] = Math.max(this.stall[field] ?? 0, record.delayMaxMs);
    if (record.droppedStallRecords > 0) this.gap("stall records dropped");
  }
  gap(reason: string): void {
    if (!this.gaps.includes(reason)) this.gaps.push(reason);
  }
  private add(set: Set<string>, value: string): void {
    if (set.size >= LIMIT) this.gap("socket limit reached");
    else set.add(value);
  }
  report(requiredCoverage: string[], provider: Counter, server: Counter) {
    const statuses = [...this.runs.values()];
    const failures = statuses.filter((s) => s === "failed" || s === "interrupted").length;
    const incomplete = statuses.filter((s) => s === "pending").length;
    const reasons = [...this.gaps, ...requiredCoverage];
    const disconnects = counter(this.socketEpisodes.size, reasons);
    const turns = counter(failures, reasons);
    const result = [disconnects, turns, provider, server].some((c) => c.observed > 0)
      ? "fail"
      : [disconnects, turns, provider, server].some((c) => c.coverage !== "complete") || incomplete
        ? "inconclusive"
        : "pass";
    return {
      version: 1,
      result,
      counters: {
        clientDisconnects: disconnects,
        turnFailures: turns,
        providerRestarts: provider,
        serverRestarts: server,
      },
      runs: {
        issued: statuses.length,
        completed: statuses.filter((s) => s === "completed").length,
        completedInWindow: this.completedInWindow,
        completedDuringDrain: this.completedDuringDrain,
        failed: statuses.filter((s) => s === "failed").length,
        interrupted: statuses.filter((s) => s === "interrupted").length,
        incomplete,
      },
      throughputPerMinute: null,
      stall: { ...this.stall, coverage: reasons.length ? "unknown" : "complete" },
    };
  }
}
