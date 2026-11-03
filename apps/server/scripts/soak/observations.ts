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
export function linuxMemoryPressure(contents: string): 1 | 2 | 4 {
  const parse = (name: string) => {
    const line = contents.split("\n").find((entry) => entry.startsWith(`${name} `));
    const match = line?.match(/(?:^|\s)avg10=(\d+(?:\.\d+)?)(?:\s|$)/);
    if (!match?.[1]) throw new Error(`missing Linux memory pressure ${name}`);
    return Number(match[1]);
  };
  const some = parse("some");
  const full = parse("full");
  return full > 0 ? 4 : some >= 10 ? 2 : 1;
}
export function codexEvidence(
  contents: string,
  excludedThreads: readonly string[],
  window: { start: string; end: string } | undefined,
) {
  const turns = new Map<string, { scheduled?: number; started?: number; completed?: number }>();
  const errors: string[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) throw new Error("invalid record");
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.threadId !== "string" ||
        typeof entry.turnId !== "string" ||
        typeof entry.at !== "string" ||
        !["scheduled", "started", "completed"].includes(String(entry.event))
      )
        throw new Error("invalid record");
      if (excludedThreads.includes(entry.threadId)) continue;
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at)) throw new Error("invalid timestamp");
      const turn = turns.get(entry.turnId) ?? {};
      if (entry.event === "scheduled") turn.scheduled = at;
      if (entry.event === "started") turn.started = at;
      if (entry.event === "completed") turn.completed = at;
      turns.set(entry.turnId, turn);
    } catch {
      errors.push("invalid Codex sidecar record");
    }
  }
  if (contents && !contents.endsWith("\n")) errors.push("partial Codex sidecar line");
  const start = window ? Date.parse(window.start) : NaN;
  const end = window ? Date.parse(window.end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    errors.push("Codex observation window unavailable");
  const within = (time: number) => time >= start && time <= end;
  const values = [...turns.values()];
  return {
    delayedStarts: values.filter(
      (t) =>
        t.scheduled !== undefined &&
        t.started !== undefined &&
        within(t.scheduled) &&
        within(t.started) &&
        t.started - t.scheduled >= 30_000,
    ).length,
    longCompletedTurns: values.filter(
      (t) =>
        t.scheduled !== undefined &&
        t.started !== undefined &&
        t.completed !== undefined &&
        within(t.scheduled) &&
        within(t.started) &&
        within(t.completed) &&
        t.completed - t.started > 60_000,
    ).length,
    errors: [...new Set(errors)],
  };
}
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
  private readonly limit: number;
  private bytes = 0;
  truncated = false;
  constructor(path: string, limit = 64 * 1024 * 1024) {
    this.limit = limit;
    this.fd = NodeFS.openSync(path, "wx", 0o600);
  }
  write(value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.limit) {
      this.truncated = true;
      return;
    }
    NodeFS.writeSync(this.fd, line);
    this.bytes += size;
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
type Release = { thread: string; at: string; status: "stopped" | "error"; requested?: boolean };
type Death = { thread: string; instance: string; at: string };
export function providerCoverageGaps(
  lines: Lifecycle[],
  joins: Map<string, string>,
  replayThreads: readonly string[],
  codexInstances: readonly string[],
): string[] {
  const starts = new Set(
    lines.filter((line) => line.event === "start").map((line) => `${line.instance}:${line.pid}`),
  );
  const joined = lines.filter(
    (line) =>
      line.event === "session" &&
      line.thread &&
      joins.has(line.thread) &&
      starts.has(`${line.instance}:${line.pid}`),
  );
  return [
    ...replayThreads
      .filter(
        (thread) =>
          !joined.some(
            (line) =>
              line.instance === "devReplay" && line.thread && joins.get(line.thread) === thread,
          ),
      )
      .map((thread) => `Replay thread ${thread} has no joined session-bearing pid`),
    ...codexInstances
      .filter((instance) => !joined.some((line) => line.instance === instance))
      .map((instance) => `Codex instance ${instance} has no joined session-bearing pid`),
  ];
}
export function providerRestarts(
  lines: Lifecycle[],
  joins: Map<string, string>,
  releases: Release[],
  deaths: Death[],
  coverageReasons: string[],
  window?: { start: string; end: string; disappeared: number[] },
) {
  const reasons = [...coverageReasons];
  const starts = lines.filter((line) => line.event === "start");
  const sessions = lines.filter((line) => line.event === "session");
  const sessionPids = new Set(sessions.map((line) => line.pid));
  const probeStarts = starts.filter((line) => !sessionPids.has(line.pid)).length;
  const groups = new Map<string, Lifecycle[]>();
  for (const session of sessions) {
    const thread = session.thread && joins.get(session.thread);
    if (!thread) {
      reasons.push(`unjoined session pid ${session.pid}`);
      continue;
    }
    const group = groups.get(thread) ?? [];
    if (!group.some((existing) => existing.pid === session.pid)) group.push(session);
    groups.set(thread, group);
  }
  let extraSessions = 0;
  let processExitEpisodes = 0;
  let processExitRunEpisodes = 0;
  const matchedPids = new Set<number>();
  const matchedDeaths = new Set<number>();
  const usedReleases = new Set<number>();
  const matchProcessDeaths = (pid: number, end: string) => {
    for (const [affectedThread, sessionsForThread] of groups) {
      const session = sessionsForThread.find((item) => item.pid === pid);
      if (!session) continue;
      const replacement = sessionsForThread
        .filter((item) => item.at > session.at)
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      const latest = replacement && replacement.at < end ? replacement.at : end;
      deaths.forEach((entry, index) => {
        if (entry.thread === affectedThread && entry.at >= session.at && entry.at <= latest)
          matchedDeaths.add(index);
      });
    }
  };
  for (const [thread, group] of groups) {
    group.sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 1; i < group.length; i++) {
      const previous = group[i - 1];
      const next = group[i];
      if (!previous || !next) continue;
      if (!window || next.at < window.start || next.at > window.end) continue;
      const releaseIndex = releases.findIndex(
        (release, index) =>
          !usedReleases.has(index) &&
          release.thread === thread &&
          release.status === "stopped" &&
          release.at >= previous.at &&
          release.at <= next.at,
      );
      if (releaseIndex >= 0) {
        usedReleases.add(releaseIndex);
        continue;
      }
      if (!matchedPids.has(previous.pid)) extraSessions++;
      matchedPids.add(previous.pid);
      matchProcessDeaths(previous.pid, window.end);
      const exit = lines.find(
        (line) =>
          line.event === "exit" &&
          line.pid === previous.pid &&
          line.at >= previous.at &&
          line.at <= next.at,
      );
      if (exit) matchedPids.add(previous.pid);
      deaths.forEach((entry, index) => {
        if (entry.thread === thread && entry.at >= previous.at && entry.at <= next.at)
          matchedDeaths.add(index);
      });
    }
  }
  if (window) {
    for (const pid of sessionPids) {
      const exit = lines.find(
        (line) =>
          line.event === "exit" &&
          line.pid === pid &&
          line.at >= window.start &&
          line.at <= window.end,
      );
      const anyExit = lines.find((line) => line.event === "exit" && line.pid === pid);
      const disappeared = !anyExit && window.disappeared.includes(pid);
      if ((!exit && !disappeared) || matchedPids.has(pid)) continue;
      const pidThreads = [...groups]
        .filter(([, group]) =>
          group.some((session) => session.pid === pid && (!exit || session.at < exit.at)),
        )
        .map(([thread]) => thread);
      if (!pidThreads.length) continue;
      if (exit) {
        const pidSessions = sessions.filter(
          (session) =>
            session.pid === pid && session.instance === exit.instance && session.at < exit.at,
        );
        const joinedThreads = pidSessions.map(
          (session) => session.thread && joins.get(session.thread),
        );
        const requested =
          pidSessions.length > 0 &&
          joinedThreads.every(Boolean) &&
          pidThreads.every((thread) =>
            releases.some(
              (release) =>
                release.thread === thread &&
                release.status === "stopped" &&
                release.at < exit.at &&
                pidSessions.some(
                  (session) =>
                    session.thread &&
                    joins.get(session.thread) === thread &&
                    session.at < release.at,
                ) &&
                !sessions.some(
                  (session) =>
                    session.at >= release.at &&
                    session.at < exit.at &&
                    (session.pid === pid ||
                      (session.thread && joins.get(session.thread) === thread)),
                ),
            ),
          );
        if (requested) continue;
      }
      if (
        disappeared &&
        sessions.some((session) => session.pid === pid && session.at < window.start)
      )
        reasons.push(`provider pid ${pid} disappearance time unknown`);
      processExitEpisodes++;
      matchedPids.add(pid);
      deaths.forEach((entry, index) => {
        const group = groups.get(entry.thread);
        const session = group?.find((item) => item.pid === pid);
        const next = group
          ?.filter((item) => session && item.at > session.at)
          .sort((a, b) => a.at.localeCompare(b.at))[0];
        if (
          session &&
          entry.at >= session.at &&
          entry.at >= window.start &&
          entry.at <= window.end &&
          (!next || entry.at <= next.at)
        )
          matchedDeaths.add(index);
      });
    }
  } else reasons.push("provider process exit window unavailable");
  processExitRunEpisodes = window
    ? deaths.filter(
        (death, index) =>
          death.at >= window.start && death.at <= window.end && !matchedDeaths.has(index),
      ).length
    : 0;
  if ([lines.length, releases.length, deaths.length].some((n) => n >= LIMIT))
    reasons.push("observation limit reached");
  return {
    counter: counter(extraSessions + processExitEpisodes + processExitRunEpisodes, [
      ...new Set(reasons),
    ]),
    probeStarts,
    extraSessions,
    processExitEpisodes,
    processExitRunEpisodes,
  };
}

export class Observations {
  readonly lifecycle: Lifecycle[] = [];
  private unknownCodexMethods = 0;
  readonly replayThreads = new Set<string>();
  readonly codexInstances = new Set<string>();
  readonly joins = new Map<string, string>();
  readonly releases: Release[] = [];
  readonly deaths: Death[] = [];
  private deathRuns = new Set<string>();
  private socketEpisodes = new Set<string>();
  private runs = new Map<string, "pending" | "completed" | "failed" | "interrupted">();
  private runRequests = 0;
  readonly streamGaps: string[] = [];
  readonly lifecycleGaps: string[] = [];
  readonly socketGaps: string[] = [];
  readonly stallGaps: string[] = [];
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
  registerProviderCohort(thread: string, instance: string): void {
    const target = instance === "devReplay" ? this.replayThreads : this.codexInstances;
    if (target.size >= LIMIT) this.lifecycleGaps.push("provider cohort limit reached");
    else target.add(instance === "devReplay" ? thread : instance);
  }
  consumeLifecycle(value: unknown): void {
    if (typeof value !== "object" || value === null) throw new Error("invalid lifecycle record");
    const line = value as Record<string, unknown>;
    if (line.event === "unknown-method") {
      if (
        typeof line.method !== "string" ||
        typeof line.pid !== "number" ||
        typeof line.instance !== "string" ||
        typeof line.at !== "string"
      )
        throw new Error("invalid unknown method record");
      this.unknownCodexMethods++;
      return;
    }
    if (
      (line.event !== "start" && line.event !== "session" && line.event !== "exit") ||
      typeof line.pid !== "number" ||
      typeof line.instance !== "string" ||
      typeof line.at !== "string" ||
      (line.event === "session" && typeof line.thread !== "string")
    )
      throw new Error("invalid lifecycle record");
    if (this.lifecycle.length >= LIMIT)
      this.lifecycleGaps.push("lifecycle observation limit reached");
    else this.lifecycle.push(line as Lifecycle);
  }
  joinProvider(native: string, thread: string): void {
    const existing = this.joins.get(native);
    if (existing && existing !== thread)
      this.lifecycleGaps.push(`ambiguous native thread ${native}`);
    else this.joins.set(native, thread);
  }
  releaseProvider(thread: string, at: string, status: "stopped" | "error"): void {
    if (this.releases.length >= LIMIT) this.lifecycleGaps.push("release observation limit reached");
    else this.releases.push({ thread, at, status, requested: status === "stopped" });
  }
  providerDeath(run: string, thread: string, instance: string, at: string): void {
    if (this.deathRuns.has(run)) return;
    if (this.deaths.length >= LIMIT) this.lifecycleGaps.push("death observation limit reached");
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
  requestRun(): void {
    this.runRequests++;
  }
  streamGap(reason: string): void {
    if (!this.streamGaps.includes(reason)) this.streamGaps.push(reason);
  }
  stallGap(reason: string): void {
    if (!this.stallGaps.includes(reason)) this.stallGaps.push(reason);
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
      this.stallGap("invalid stall record");
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      (record.phase !== "startup" && record.phase !== "runtime") ||
      typeof record.delayMaxMs !== "number" ||
      !Number.isFinite(record.delayMaxMs) ||
      typeof record.droppedStallRecords !== "number" ||
      !Number.isFinite(record.droppedStallRecords)
    ) {
      this.stallGap("invalid stall record");
      return;
    }
    this.stall.samples++;
    this.stall.droppedRecords = Math.max(this.stall.droppedRecords, record.droppedStallRecords);
    const field = record.phase === "startup" ? "startupMaxMs" : "runtimeMaxMs";
    this.stall[field] = Math.max(this.stall[field] ?? 0, record.delayMaxMs);
    if (record.droppedStallRecords > 0) this.stallGap("stall records dropped");
  }
  gap(reason: string): void {
    if (!this.gaps.includes(reason)) this.gaps.push(reason);
  }
  private add(set: Set<string>, value: string): void {
    if (set.size >= LIMIT) this.socketGaps.push("socket limit reached");
    else set.add(value);
  }
  report(
    requiredCoverage: string[],
    provider: Counter,
    server: Counter,
    socketCoverage = requiredCoverage,
  ) {
    const statuses = [...this.runs.values()];
    const failures = statuses.filter((s) => s === "failed" || s === "interrupted").length;
    const incomplete = statuses.filter((s) => s === "pending").length;
    const reasons = [...this.gaps, ...requiredCoverage];
    const disconnects = counter(this.socketEpisodes.size, socketCoverage);
    const turns = counter(failures, [
      ...this.streamGaps,
      ...(incomplete ? ["issued runs remain incomplete"] : []),
      ...(this.runRequests !== statuses.length
        ? ["issued run requests do not match observed runs"]
        : []),
    ]);
    const result = [disconnects, turns, provider, server].some((c) => c.observed > 0)
      ? "fail"
      : reasons.length > 0 ||
          [disconnects, turns, provider, server].some((c) => c.coverage !== "complete") ||
          incomplete
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
        unknownCodexMethods: counter(this.unknownCodexMethods, this.lifecycleGaps),
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
      stall: {
        ...this.stall,
        ...(this.stall.runtimeMaxMs === null &&
        this.stall.startupMaxMs !== null &&
        this.stallGaps.length === 0 &&
        this.stall.droppedRecords === 0
          ? { belowThresholdMs: 2000 }
          : {}),
        reasons: this.stallGaps,
        coverage:
          this.stallGaps.length || this.stall.startupMaxMs === null || this.stall.droppedRecords > 0
            ? "unknown"
            : "complete",
      },
    };
  }
}
