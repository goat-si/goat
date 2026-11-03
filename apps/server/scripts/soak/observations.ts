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
  private socketEpisodes = new Set<string>();
  private runs = new Map<string, "pending" | "completed" | "failed" | "interrupted">();
  readonly gaps: string[] = [];
  readonly stall = {
    runtimeMaxMs: null as number | null,
    startupMaxMs: null as number | null,
    samples: 0,
    droppedRecords: 0,
  };
  readonly trace = { retired: 0 };
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
  recordRun(id: string, status: "completed" | "failed" | "interrupted"): void {
    if (this.runs.get(id) === "pending") this.runs.set(id, status);
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
        failed: failures,
        incomplete,
      },
      stall: { ...this.stall, coverage: reasons.length ? "unknown" : "complete" },
    };
  }
}
