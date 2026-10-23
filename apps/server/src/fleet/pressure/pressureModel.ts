/**
 * Resource pressure decisions, free of I/O (ADR-0020): classify one host sample against the
 * thresholds, hold a level with hysteresis, decide when orchestrating threads hear about it, find
 * those threads, and rank hosts for a new lane.
 *
 * @module pressureModel
 */
import {
  DEFAULT_HOST_PRESSURE_SETTINGS,
  FLEET_LOCAL_HOST_KEY,
  type HostCapacitySnapshot,
  type HostPlacementCandidate,
  type HostPlacementRanking,
  type HostPlacementRequirements,
  type HostPressure,
  type HostPressureAdvice,
  type HostPressureLevel,
  type HostPressureReason,
  type HostPressureSettings,
  type HostStatusEntry,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import {
  busiestWindow,
  isExhausted,
  LOAD_PENALTY,
  UNKNOWN_QUOTA_PERCENT,
} from "../../channels/channelPlacement.ts";

export type ResolvedPressureSettings = {
  -readonly [K in keyof typeof DEFAULT_HOST_PRESSURE_SETTINGS]-?: NonNullable<
    HostPressureSettings[K]
  >;
};

export function resolvePressureSettings(
  settings: HostPressureSettings | undefined,
): ResolvedPressureSettings {
  const resolved: ResolvedPressureSettings = { ...DEFAULT_HOST_PRESSURE_SETTINGS };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value !== undefined) Object.assign(resolved, { [key]: value });
  }
  return resolved;
}

/** A level is left only once its readings fall this far below the thresholds that raised it. */
const EXIT_RATIO = 0.8;
const GIB = 1024 ** 3;

/**
 * Server stalls are a GOAT health signal counted over this window. A test run or build regularly
 * stalls the loop for two or three seconds once; only a repeat says the machine is struggling.
 */
const STALL_WINDOW_MS = 10 * 60_000;
/** Stalls of at least half criticalEventLoopDelayMs this many times in the window: elevated. */
const REPEATED_STALLS = 3;
/** Stalls of at least criticalEventLoopDelayMs this many times in the window: critical. */
const REPEATED_CRITICAL_STALLS = 2;
/** One stall this many times criticalEventLoopDelayMs is critical at once: remote follows fail. */
const SEVERE_STALL_FACTOR = 3;

const RANK: Record<HostPressureLevel, number> = { ok: 0, elevated: 1, critical: 2 };
const higher = (left: HostPressureLevel, right: HostPressureLevel) =>
  RANK[left] >= RANK[right] ? left : right;

/** One reading of a host. Null means the host did not report that signal. */
export interface PressureSample {
  readonly loadPerCore: number | null;
  /** Whole-host CPU busy, 0 to 1. */
  readonly cpuUtilization: number | null;
  readonly memoryFreeRatio: number | null;
  readonly diskAvailableBytes: number | null;
  /** The longest GOAT server event-loop stall since the previous sample. */
  readonly eventLoopDelayMs: number | null;
}

export function sampleFromCapacity(
  metrics: HostCapacitySnapshot,
  eventLoopDelayMs: number | null,
): PressureSample {
  return {
    loadPerCore:
      metrics.loadAvg === null || metrics.cpuCount <= 0
        ? null
        : metrics.loadAvg.oneMinute / metrics.cpuCount,
    cpuUtilization: metrics.cpuUtilization,
    memoryFreeRatio:
      metrics.totalMemoryBytes > 0 ? metrics.availableMemoryBytes / metrics.totalMemoryBytes : null,
    diskAvailableBytes: metrics.disk?.availableBytes ?? null,
    eventLoopDelayMs,
  };
}

export function sampleFromEntry(entry: HostStatusEntry): PressureSample | null {
  return entry.metrics === undefined
    ? null
    : sampleFromCapacity(entry.metrics, entry.pressure?.eventLoopDelayMs ?? null);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export interface Classification {
  readonly level: HostPressureLevel;
  readonly reasons: ReadonlyArray<HostPressureReason>;
}

/**
 * The level one sample's machine readings show; event-loop stalls are judged over a window by
 * stallPressure. `scale` below 1 loosens every threshold, so a host stays at a level until its
 * readings fall clear of where they rose (hysteresis).
 */
export function classify(
  sample: PressureSample,
  settings: ResolvedPressureSettings,
  scale = 1,
): Classification {
  const reasons: Array<HostPressureReason> = [];
  const above = (
    signal: HostPressureReason["signal"],
    value: number | null,
    elevated: number | null,
    critical: number | null,
    describe: (value: number, threshold: number) => string,
  ) => {
    if (value === null) return;
    if (critical !== null && value >= critical * scale)
      reasons.push({ signal, level: "critical", message: describe(value, critical) });
    else if (elevated !== null && value >= elevated * scale)
      reasons.push({ signal, level: "elevated", message: describe(value, elevated) });
  };
  const below = (
    signal: HostPressureReason["signal"],
    value: number | null,
    elevated: number,
    critical: number,
    describe: (value: number, threshold: number) => string,
  ) => {
    if (value === null) return;
    if (value <= critical / scale)
      reasons.push({ signal, level: "critical", message: describe(value, critical) });
    else if (value <= elevated / scale)
      reasons.push({ signal, level: "elevated", message: describe(value, elevated) });
  };
  above(
    "load",
    sample.loadPerCore,
    settings.elevatedLoadPerCore,
    settings.criticalLoadPerCore,
    (value, threshold) => "load " + round1(value) + " per core (threshold " + threshold + ")",
  );
  above(
    "cpu",
    sample.cpuUtilization === null ? null : sample.cpuUtilization * 100,
    settings.elevatedCpuPercent,
    null,
    (value, threshold) => "CPU " + Math.round(value) + "% (threshold " + threshold + "%)",
  );
  below(
    "memory",
    sample.memoryFreeRatio === null ? null : sample.memoryFreeRatio * 100,
    settings.elevatedMemoryFreePercent,
    settings.criticalMemoryFreePercent,
    (value, threshold) => "memory " + Math.round(value) + "% free (threshold " + threshold + "%)",
  );
  below(
    "disk",
    sample.diskAvailableBytes === null ? null : sample.diskAvailableBytes / GIB,
    settings.elevatedDiskFreeGiB,
    settings.criticalDiskFreeGiB,
    (value, threshold) => "disk " + round1(value) + " GiB free (threshold " + threshold + " GiB)",
  );
  const level = reasons.reduce<HostPressureLevel>((top, reason) => higher(top, reason.level), "ok");
  return { level, reasons };
}

export interface Stall {
  readonly at: number;
  readonly ms: number;
}

const seconds = (ms: number) => round1(ms / 1000) + " s";

/** The level the GOAT server's stalls in the last STALL_WINDOW_MS show. One alone is never news. */
export function stallPressure(
  stalls: ReadonlyArray<Stall>,
  settings: ResolvedPressureSettings,
): { readonly level: HostPressureLevel; readonly reason: HostPressureReason | null } {
  const critical = settings.criticalEventLoopDelayMs;
  const longest = stalls.reduce((top, stall) => Math.max(top, stall.ms), 0);
  const window = Math.round(STALL_WINDOW_MS / 60_000) + " min";
  const repeated = (count: number, threshold: number) =>
    "GOAT server stalled " +
    count +
    " times over " +
    seconds(threshold) +
    " in " +
    window +
    " (longest " +
    seconds(longest) +
    ")";
  if (longest >= critical * SEVERE_STALL_FACTOR)
    return {
      level: "critical",
      reason: {
        signal: "event_loop",
        level: "critical",
        message:
          "GOAT server stalled " +
          seconds(longest) +
          " (threshold " +
          seconds(critical * SEVERE_STALL_FACTOR) +
          ")",
      },
    };
  const long = stalls.filter((stall) => stall.ms >= critical).length;
  if (long >= REPEATED_CRITICAL_STALLS)
    return {
      level: "critical",
      reason: { signal: "event_loop", level: "critical", message: repeated(long, critical) },
    };
  const noticeable = stalls.filter((stall) => stall.ms >= critical / 2).length;
  if (noticeable >= REPEATED_STALLS)
    return {
      level: "elevated",
      reason: {
        signal: "event_loop",
        level: "elevated",
        message: repeated(noticeable, critical / 2),
      },
    };
  return { level: "ok", reason: null };
}

/** A host's held level plus how long each nearby level has been continuously shown. */
export interface PressureState {
  readonly level: HostPressureLevel;
  readonly since: number;
  readonly reasons: ReadonlyArray<HostPressureReason>;
  readonly loadPerCore: number | null;
  /** Since when every sample reached elevated, or critical, on the raising thresholds. */
  readonly atLeastSince: { readonly elevated: number | null; readonly critical: number | null };
  /** Since when every sample stayed at or under ok, or elevated, on the loosened thresholds. */
  readonly atMostSince: { readonly ok: number | null; readonly elevated: number | null };
  /** Event-loop stalls in the last STALL_WINDOW_MS, oldest first. */
  readonly stalls: ReadonlyArray<Stall>;
}

export const initialPressureState = (now: number): PressureState => ({
  level: "ok",
  since: now,
  reasons: [],
  loadPerCore: null,
  atLeastSince: { elevated: null, critical: null },
  atMostSince: { ok: null, elevated: null },
  stalls: [],
});

/**
 * Feeds one sample. A level rises once machine readings have held it for sustainMs, or once
 * stalls repeat inside their window. It falls once every reading stays under the loosened
 * thresholds, and stalls under theirs, for recoverMs.
 */
export function stepPressure(
  state: PressureState,
  sample: PressureSample,
  settings: ResolvedPressureSettings,
  now: number,
): PressureState {
  const enter = classify(sample, settings);
  const stay = classify(sample, settings, EXIT_RATIO);
  const stalled = sample.eventLoopDelayMs;
  const stalls = [
    ...state.stalls.filter((stall) => now - stall.at < STALL_WINDOW_MS),
    ...(stalled !== null && stalled > 0 ? [{ at: now, ms: stalled }] : []),
  ];
  const stall = stallPressure(stalls, settings);
  const clear = higher(stay.level, stall.level);
  const since = (current: number | null, holds: boolean) => (holds ? (current ?? now) : null);
  const atLeastSince = {
    elevated: since(state.atLeastSince.elevated, RANK[enter.level] >= RANK.elevated),
    critical: since(state.atLeastSince.critical, RANK[enter.level] >= RANK.critical),
  };
  const atMostSince = {
    ok: since(state.atMostSince.ok, clear === "ok"),
    elevated: since(state.atMostSince.elevated, RANK[clear] <= RANK.elevated),
  };
  const held = (start: number | null, ms: number) => start !== null && now - start >= ms;
  const sustained = (start: number | null) => held(start, settings.sustainMs);
  const recovered = (start: number | null) => held(start, settings.recoverMs);
  const risen: HostPressureLevel = higher(
    stall.level,
    sustained(atLeastSince.critical)
      ? "critical"
      : sustained(atLeastSince.elevated)
        ? "elevated"
        : "ok",
  );
  let level = state.level;
  if (RANK[risen] > RANK[level]) level = risen;
  else if (level === "critical" && recovered(atMostSince.ok)) level = "ok";
  else if (level === "critical" && recovered(atMostSince.elevated)) level = "elevated";
  else if (level === "elevated" && recovered(atMostSince.ok)) level = "ok";
  const current = [
    ...(enter.reasons.length > 0 ? enter.reasons : stay.reasons),
    ...(stall.reason === null ? [] : [stall.reason]),
  ];
  return {
    level,
    since: level === state.level ? state.since : now,
    reasons: level === "ok" ? [] : current.length > 0 ? current : state.reasons,
    loadPerCore: sample.loadPerCore,
    atLeastSince,
    atMostSince,
    stalls,
  };
}

export const toHostPressure = (state: PressureState): HostPressure => {
  const longest = state.stalls.reduce((top, stall) => Math.max(top, stall.ms), 0);
  return {
    level: state.level,
    since: DateTime.formatIso(DateTime.makeUnsafe(state.since)),
    reasons: [...state.reasons],
    loadPerCore: state.loadPerCore === null ? null : Math.round(state.loadPerCore * 100) / 100,
    eventLoopDelayMs: longest > 0 ? Math.round(longest) : null,
  };
};

/**
 * The one status notice each orchestrating thread keeps per host. Its id goes into the record key,
 * so writing it again updates the same timeline row in place.
 */
export interface PressureRow {
  readonly id: string;
  readonly openedAt: number;
  /** Threads holding this row; later updates reach them even after their work there finished. */
  readonly recipients: ReadonlyArray<string>;
}

/** What orchestrating threads were last told about one host. */
export interface AnnouncedPressure {
  readonly level: HostPressureLevel;
  readonly row: PressureRow | null;
  /** When each level last woke them. */
  readonly wokeAt: Partial<Record<HostPressureLevel, number>>;
}

export const NOTHING_ANNOUNCED: AnnouncedPressure = { level: "ok", row: null, wokeAt: {} };

export type PressureNudgeKind = "rise" | "ease" | "recover";

export interface PressureNudge {
  readonly kind: PressureNudgeKind;
  /** Write the host's status row: a new one when `opened`, else the current one in place. */
  readonly row: { readonly id: string; readonly opened: boolean } | null;
  /** Also start a turn in each orchestrating thread with the full notice. */
  readonly wake: boolean;
}

/**
 * What a host's new level changes in its orchestrators' timelines. A rise opens a status row at
 * most once per cooldown; within it, every later change rewrites that row in place. Easing and
 * recovery only ever rewrite an existing row, so a short episode adds nothing new. A rise to a
 * level delivered as "wake" wakes its threads at once, at most once per level per cooldown, even
 * when the row itself is only updated: getting worse is always news.
 */
export function nudgeDecision(
  announced: AnnouncedPressure,
  level: HostPressureLevel,
  now: number,
  settings: Pick<
    ResolvedPressureSettings,
    "notifyCooldownMs" | "elevatedDelivery" | "criticalDelivery"
  >,
): { readonly next: AnnouncedPressure; readonly nudge: PressureNudge | null } {
  if (level === announced.level) return { next: announced, nudge: null };
  const kind: PressureNudgeKind =
    level === "ok" ? "recover" : RANK[level] > RANK[announced.level] ? "rise" : "ease";
  const current = announced.row;
  const delivery =
    level === "critical"
      ? settings.criticalDelivery
      : level === "elevated"
        ? settings.elevatedDelivery
        : "off";
  if (kind !== "rise" || delivery === "off")
    return {
      next: { ...announced, level },
      nudge:
        current === null ? null : { kind, row: { id: current.id, opened: false }, wake: false },
    };
  const reuse = current !== null && now - current.openedAt < settings.notifyCooldownMs;
  const row: PressureRow = reuse ? current : { id: String(now), openedAt: now, recipients: [] };
  const woke = announced.wokeAt[level];
  const wake =
    delivery === "wake" && (woke === undefined || now - woke >= settings.notifyCooldownMs);
  return {
    next: { level, row, wokeAt: wake ? { ...announced.wokeAt, [level]: now } : announced.wokeAt },
    nudge: { kind, row: { id: row.id, opened: !reuse }, wake },
  };
}

type ShellLike = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "status"
  | "activityRunStatus"
  | "archivedAt"
  | "deletedAt"
  | "lineage"
  | "launchedBy"
  | "worktreePath"
  | "branch"
>;

export interface PressureConsumer {
  readonly threadId: string;
  readonly title: string | null;
  readonly worktreePath: string | null;
  readonly launcherThreadId: string | null;
}

const RUNNING = new Set(["preparing", "starting", "running"]);
const isRunning = (shell: ShellLike) =>
  RUNNING.has(shell.activityRunStatus ?? "") || RUNNING.has(shell.status);
const isLive = (shell: ShellLike) => shell.archivedAt == null && shell.deletedAt == null;

/** The local thread that started this one: its launcher here, or the parent of a subagent. */
function localParent(shell: ShellLike, environmentId: string): string | null {
  const launcher = shell.launchedBy;
  if (
    launcher !== undefined &&
    launcher.kind === "launch" &&
    (launcher.environmentId === null || launcher.environmentId === environmentId)
  )
    return launcher.threadId;
  if (shell.lineage.relationshipToParent === "subagent") return shell.lineage.parentThreadId;
  return null;
}

const MAX_ANCESTRY = 6;

/**
 * Who should hear about pressure on one host: each thread that started work running there, and its
 * own launchers up to the thread a person started, all on this machine. Subagents cannot take a
 * message, so their parents stand in. Consumers are the running work itself, busiest first by
 * launch order.
 */
export function pressureRecipients(input: {
  readonly host: string | null;
  readonly environmentId: string;
  readonly shells: ReadonlyArray<ShellLike>;
  readonly watches: ReadonlyArray<{
    readonly launcherThreadId: string | null;
    readonly host: string | null;
    readonly threadId: string;
    readonly title: string | null;
    readonly pendingRuns: ReadonlyArray<string>;
  }>;
}): {
  readonly recipients: ReadonlyArray<string>;
  readonly consumers: ReadonlyArray<PressureConsumer>;
} {
  const byId = new Map(input.shells.map((shell) => [shell.id as string, shell]));
  const consumers: Array<PressureConsumer> =
    input.host === null
      ? input.shells
          .filter((shell) => isLive(shell) && isRunning(shell))
          .map((shell) => ({
            threadId: shell.id,
            title: shell.title,
            worktreePath: shell.worktreePath,
            launcherThreadId: localParent(shell, input.environmentId),
          }))
      : input.watches
          .filter((watch) => watch.host === input.host && watch.pendingRuns.length > 0)
          .map((watch) => ({
            threadId: watch.threadId,
            title: watch.title,
            worktreePath: null,
            launcherThreadId: watch.launcherThreadId,
          }));
  const recipients = new Set<string>();
  for (const consumer of consumers) {
    let current = consumer.launcherThreadId;
    for (let depth = 0; current !== null && depth < MAX_ANCESTRY; depth += 1) {
      const shell = byId.get(current);
      if (shell === undefined || !isLive(shell)) break;
      if (shell.lineage.relationshipToParent !== "subagent") recipients.add(current);
      current = localParent(shell, input.environmentId);
    }
  }
  return { recipients: [...recipients].toSorted(), consumers };
}

/** A host's level from its own report, or from its metrics alone when it predates pressure. */
function entryLevel(
  entry: HostStatusEntry,
  settings: ResolvedPressureSettings,
): HostPressureLevel | "unknown" {
  if (entry.reachability !== "ok" || entry.lastKnown === true) return "unknown";
  if (entry.pressure !== undefined) return entry.pressure.level;
  const sample = sampleFromEntry(entry);
  return sample === null ? "unknown" : classify(sample, settings).level;
}

const hostLabel = (host: string | null) => host ?? "this machine";
const ELEVATED_PENALTY = 200;

/**
 * Ranks hosts for one new lane. Filters first, then scores with channelPlacement's weights: each
 * running or queued thread adds LOAD_PENALTY, load per core counts as a percentage, the requested
 * provider's busiest quota window counts as in choosePlacement, and an elevated host pays a flat
 * penalty. A critical host is skipped.
 */
export function rankHosts(
  entries: ReadonlyArray<HostStatusEntry>,
  requirements: HostPlacementRequirements,
  settings: ResolvedPressureSettings,
  now: number,
): HostPlacementRanking {
  const ranked: Array<HostPlacementCandidate> = entries.map((entry) => {
    const pressure = entryLevel(entry, settings);
    const skip = (reason: string): HostPlacementCandidate => ({
      host: entry.host,
      eligible: false,
      score: null,
      pressure,
      reasons: [reason],
    });
    const metrics = entry.metrics;
    if (entry.reachability === "unsupported") return skip("does not report host status");
    if (entry.reachability !== "ok") return skip("unreachable");
    if (entry.lastKnown === true || metrics === undefined) return skip("status is stale");
    if (entry.compatibility === "incompatible") return skip("needs a GOAT update");
    const blocked = entry.conditions?.find(
      (condition) => condition.type === "Cordoned" || condition.type === "Draining",
    );
    if (blocked !== undefined) return skip(blocked.type.toLowerCase());
    if (requirements.platform !== undefined && metrics.platform !== requirements.platform)
      return skip("runs " + (metrics.platform ?? "an unknown platform"));
    const providers =
      metrics.providers ?? metrics.quotas.map((quota) => ({ ...quota, enabled: true }));
    if (
      requirements.driver !== undefined &&
      !providers.some((provider) => provider.enabled && provider.driver === requirements.driver)
    )
      return skip("has no enabled " + requirements.driver + " provider");
    const reasons: Array<string> = [];
    let quotaScore = 0;
    if (requirements.providerInstanceId !== undefined) {
      const instance = providers.find(
        (provider) => provider.instanceId === requirements.providerInstanceId,
      );
      if (instance === undefined || !instance.enabled)
        return skip(requirements.providerInstanceId + " is not enabled there");
      const quota = metrics.quotas.find(
        (item) => item.instanceId === requirements.providerInstanceId,
      );
      const candidate = {
        value: null,
        host: entry.host,
        providerLabel: requirements.providerInstanceId,
        preferred: false,
        windows: quota === undefined ? null : quota.limits.windows,
        activeTasks: 0,
      };
      if (isExhausted(candidate, now))
        return skip(requirements.providerInstanceId + " is at its usage limit");
      const used = busiestWindow(candidate);
      quotaScore = used?.usedPercent ?? UNKNOWN_QUOTA_PERCENT;
      if (used !== null) reasons.push(used.usedPercent + "% " + used.label.toLowerCase() + " used");
    }
    if (pressure === "critical")
      return skip(
        "critical: " +
          (entry.pressure?.reasons.map((reason) => reason.message).join(", ") ?? "overloaded"),
      );
    const sample = sampleFromEntry(entry);
    const busy = sample?.loadPerCore ?? sample?.cpuUtilization ?? 0;
    const threads = metrics.threads.running + metrics.threads.queued;
    reasons.unshift(
      (sample?.loadPerCore === null || sample === null
        ? "CPU " + Math.round((sample?.cpuUtilization ?? 0) * 100) + "%"
        : "load " + round1(busy) + " per core") +
        ", " +
        threads +
        (threads === 1 ? " thread" : " threads") +
        " running or queued",
    );
    if (pressure === "elevated") reasons.push("elevated pressure");
    return {
      host: entry.host,
      eligible: true,
      score: Math.round(
        LOAD_PENALTY * threads +
          100 * busy +
          quotaScore +
          (pressure === "elevated" ? ELEVATED_PENALTY : 0),
      ),
      pressure,
      reasons,
    };
  });
  const candidates = [
    ...ranked
      .filter((candidate) => candidate.eligible)
      .toSorted((left, right) => (left.score ?? 0) - (right.score ?? 0)),
    ...ranked.filter((candidate) => !candidate.eligible),
  ];
  const best = candidates[0];
  const avoid = candidates.filter((candidate) => candidate.pressure === "critical");
  const suggestion =
    best === undefined || !best.eligible
      ? "No host can take this lane now; queue it or wait for load to drop."
      : "Start the next lane on " +
        hostLabel(best.host) +
        " (" +
        best.reasons.join("; ") +
        ")." +
        (avoid.length === 0
          ? ""
          : " Avoid " + avoid.map((candidate) => hostLabel(candidate.host)).join(", ") + ".");
  return { candidates, suggestion };
}

/** Hosts with room for more work, best first, never the pressured one. */
export function roomyHosts(
  entries: ReadonlyArray<HostStatusEntry>,
  exclude: string | null,
  settings: ResolvedPressureSettings,
  now: number,
): ReadonlyArray<HostPlacementCandidate> {
  return rankHosts(entries, {}, settings, now).candidates.filter(
    (candidate) => candidate.eligible && candidate.pressure === "ok" && candidate.host !== exclude,
  );
}

export function launchAdvice(input: {
  readonly host: string | null;
  readonly pressure: HostPressure;
  readonly alternatives: ReadonlyArray<HostPlacementCandidate>;
}): HostPressureAdvice | undefined {
  const level = input.pressure.level;
  if (level === "ok") return undefined;
  const why = input.pressure.reasons.map((reason) => reason.message).join(", ");
  const elsewhere =
    input.alternatives.length === 0
      ? " No other host has room now; queue heavy lanes until it eases."
      : " Hosts with room: " +
        input.alternatives
          .slice(0, 3)
          .map((candidate) => hostLabel(candidate.host))
          .join(", ") +
        ".";
  return {
    host: input.host,
    level,
    message:
      hostLabel(input.host) +
      " is under " +
      level +
      " resource pressure" +
      (why.length === 0 ? "" : " (" + why + ")") +
      ". Keep heavy work (installs, browser test suites, typechecks) off it." +
      elsewhere,
    alternatives: input.alternatives.slice(0, 3).map((candidate) => candidate.host),
  };
}

const MAX_LISTED = 6;

interface PressureTextInput {
  readonly kind: PressureNudgeKind;
  readonly host: string | null;
  readonly pressure: HostPressure;
  readonly consumers: ReadonlyArray<PressureConsumer>;
  readonly recipient: string;
  readonly alternatives: ReadonlyArray<HostPlacementCandidate>;
}

/** "13:37 UTC" from an ISO instant. */
const clockTime = (iso: string) => iso.slice(11, 16) + " UTC";

/** The details under a notice: why, what runs there, where else to go, what to do. */
function pressureDetails(input: PressureTextInput): ReadonlyArray<string> {
  const where = hostLabel(input.host);
  const level = input.pressure.level;
  const why = input.pressure.reasons.map((reason) => "- " + reason.message);
  const consumers = input.consumers.slice(0, MAX_LISTED).map((consumer) => {
    const mine = consumer.launcherThreadId === input.recipient ? ", started by this thread" : "";
    const place = consumer.worktreePath === null ? "" : ", worktree " + consumer.worktreePath;
    return (
      '- "' +
      (consumer.title ?? "Untitled") +
      '" (threadId ' +
      consumer.threadId +
      place +
      mine +
      ")"
    );
  });
  const more =
    input.consumers.length > MAX_LISTED
      ? ["- and " + (input.consumers.length - MAX_LISTED) + " more"]
      : [];
  const room = input.alternatives
    .slice(0, 3)
    .map((candidate) => "- " + hostLabel(candidate.host) + ": " + candidate.reasons.join("; "));
  const target = input.alternatives[0];
  const action =
    level === "critical"
      ? "Pause or queue new heavy lanes (installs, browser test suites, typecheck, lint) on " +
        where +
        " and let running ones finish" +
        (target === undefined
          ? "."
          : "; start the next ones on " +
            hostLabel(target.host) +
            (target.host === null ? "." : " with goat_ssh_thread_launch."))
      : "Avoid starting more heavy lanes on " +
        where +
        (target === undefined ? "." : "; prefer " + hostLabel(target.host) + " for new ones.");
  return [
    ...why,
    ...(consumers.length === 0 ? [] : ["", "Work running there:", ...consumers, ...more]),
    ...(room.length === 0
      ? ["", "No other host has room now."]
      : ["", "Hosts with room:", ...room]),
    "",
    "Suggested: " + action + " Rank hosts with goat_host_status {placement:{}} before launching.",
  ];
}

/**
 * The host's status row in an orchestrating thread: one line with level, since and the main
 * reason, details below it. Rewritten in place as the level changes.
 */
export function pressureStatusText(input: PressureTextInput): string {
  const where = hostLabel(input.host);
  const since = clockTime(input.pressure.since);
  if (input.kind === "recover")
    return (
      "Resource pressure: " +
      where +
      " back to normal since " +
      since +
      "\nHeavy lanes can run there again; check goat_host_status before starting several at once."
    );
  const reason = input.pressure.reasons[0]?.message;
  return [
    "Resource pressure: " +
      where +
      " " +
      input.pressure.level +
      " since " +
      since +
      (reason === undefined ? "" : " · " + reason),
    ...pressureDetails(input),
  ].join("\n");
}

/**
 * The message that wakes an orchestrating thread when a host gets worse. It goes into the
 * agent's context, so it says what to do and where to go next in three lines; host.status lists
 * the work running there and every host's room.
 */
export function pressureNudgeText(input: PressureTextInput): {
  readonly text: string;
  readonly summary: string;
} {
  const where = hostLabel(input.host);
  const level = input.pressure.level;
  const reason = input.pressure.reasons[0]?.message;
  const mine = input.consumers.filter((consumer) => consumer.launcherThreadId === input.recipient);
  const target = input.alternatives[0];
  const next =
    target === undefined
      ? "No other host has room now."
      : hostLabel(target.host) +
        " has room (" +
        target.reasons.join("; ") +
        ")" +
        (level === "critical"
          ? "; start the next ones there" +
            (target.host === null ? "." : ' with goat_call {path: "ssh.thread_launch"}.')
          : ".");
  return {
    summary: where + " is under " + level + " resource pressure",
    text: [
      "Resource pressure: " + where + " is " + level + " (since " + input.pressure.since + ").",
      (reason === undefined ? "" : reason + ". ") +
        input.consumers.length +
        " threads run there, " +
        mine.length +
        " started by this thread. " +
        (level === "critical"
          ? "Pause or queue new heavy lanes there and let running ones finish. "
          : "Avoid starting more heavy lanes there. ") +
        next,
      'goat_call {path: "host.status", args: {placement: {}}} ranks hosts; goat_call {path: "thread.watch_list"} lists the threads this thread started.',
    ].join("\n"),
  };
}

export const pressureHostKey = (host: string | null) => host ?? FLEET_LOCAL_HOST_KEY;

/** Pressure wakes are keyed host-pressure:<host>:…; TurnDigest keeps one per host. */
export const HOST_PRESSURE_KEY_PREFIX = "host-pressure:";
export const HOST_PRESSURE_MESSAGE_PREFIX = `message:${HOST_PRESSURE_KEY_PREFIX}`;
