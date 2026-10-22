import { describe, expect, it } from "@effect/vitest";
import type { HostStatusEntry, OrchestrationV2ThreadShell } from "@goat/contracts";

import {
  classify,
  initialPressureState,
  nudgeDecision,
  NOTHING_ANNOUNCED,
  pressureRecipients,
  rankHosts,
  resolvePressureSettings,
  stepPressure,
  type PressureSample,
  type PressureState,
} from "./pressureModel.ts";

const settings = resolvePressureSettings(undefined);
const SECOND = 1000;
const MIN = 60 * SECOND;

const calm: PressureSample = {
  loadPerCore: 0.2,
  cpuUtilization: 0.1,
  memoryFreeRatio: 0.5,
  diskAvailableBytes: 200 * 1024 ** 3,
  eventLoopDelayMs: null,
};
const load = (loadPerCore: number): PressureSample => ({ ...calm, loadPerCore });

/** Feeds one sample every 30 s, as the monitor does, and returns the level after each. */
function levels(samples: ReadonlyArray<PressureSample>, start?: PressureState) {
  let state = start ?? initialPressureState(0);
  let at = start === undefined ? 0 : state.since;
  return samples.map((sample) => {
    state = stepPressure(state, sample, settings, at);
    at += 30 * SECOND;
    return state.level;
  });
}

describe("classify", () => {
  it("reads each signal against its threshold", () => {
    expect(classify(load(2), settings).level).toBe("elevated");
    expect(classify(load(6.2), settings).level).toBe("critical");
    expect(classify({ ...calm, cpuUtilization: 0.95 }, settings).level).toBe("elevated");
    expect(classify({ ...calm, memoryFreeRatio: 0.04 }, settings).level).toBe("critical");
    expect(classify({ ...calm, diskAvailableBytes: 5 * 1024 ** 3 }, settings).level).toBe(
      "elevated",
    );
    expect(classify(calm, settings).level).toBe("ok");
  });

  it("raises a server stall at once and names it", () => {
    const stalled = classify({ ...calm, eventLoopDelayMs: 26_380 }, settings);
    expect(stalled.immediate).toBe("critical");
    expect(stalled.reasons.map((reason) => reason.message)).toEqual([
      "GOAT server stalled 26.4 s (threshold 5 s)",
    ]);
    expect(classify({ ...calm, eventLoopDelayMs: 3_000 }, settings).immediate).toBe("elevated");
  });

  it("uses configured thresholds over the defaults", () => {
    const strict = resolvePressureSettings({ elevatedLoadPerCore: 0.5 });
    expect(classify(load(0.6), strict).level).toBe("elevated");
    expect(strict.criticalLoadPerCore).toBe(3);
  });
});

describe("stepPressure", () => {
  it("rises only after the reading holds for sustainMs", () => {
    // 0, 30, 60, 90 s are not yet two minutes; 120 s is.
    expect(levels([load(2), load(2), load(2), load(2), load(2)])).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "elevated",
    ]);
  });

  it("ignores a reading that flaps across the threshold", () => {
    expect(levels(Array.from({ length: 10 }, (_, index) => load(index % 2 === 0 ? 2 : 1)))).toEqual(
      Array.from({ length: 10 }, () => "ok"),
    );
  });

  it("holds a level until readings clear the loosened threshold for sustainMs", () => {
    let state = initialPressureState(0);
    for (let at = 0; at <= 2 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(2), settings, at);
    expect(state.level).toBe("elevated");
    // 1.3 per core is under 1.5 but above 1.5 × 0.8, so the host stays elevated.
    for (let at = 2.5 * MIN; at <= 10 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(1.3), settings, at);
    expect(state.level).toBe("elevated");
    const clearing = [];
    for (let at = 10.5 * MIN; at <= 12.5 * MIN; at += 30 * SECOND) {
      state = stepPressure(state, load(1), settings, at);
      clearing.push(state.level);
    }
    expect(clearing).toEqual(["elevated", "elevated", "elevated", "elevated", "ok"]);
  });

  it("goes critical on a stall and steps down as readings clear", () => {
    let state = stepPressure(
      initialPressureState(0),
      { ...load(2), eventLoopDelayMs: 26_380 },
      settings,
      0,
    );
    expect(state.level).toBe("critical");
    expect(state.reasons.map((reason) => reason.signal)).toEqual(["load", "event_loop"]);
    for (let at = 30 * SECOND; at < 2.5 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(2), settings, at);
    expect(state.level).toBe("critical");
    state = stepPressure(state, load(2), settings, 2.5 * MIN);
    // Two minutes after the last stall, and load is still elevated: critical eases to elevated.
    expect(state.level).toBe("elevated");
    expect(state.since).toBe(2.5 * MIN);
  });
});

describe("nudgeDecision", () => {
  const cooldown = settings.notifyCooldownMs;

  it("announces each change once and suppresses repeats inside the cooldown", () => {
    const rise = nudgeDecision(NOTHING_ANNOUNCED, "critical", 0, cooldown);
    expect(rise.kind).toBe("rise");
    expect(nudgeDecision(rise.next, "critical", MIN, cooldown).kind).toBeNull();
    const ease = nudgeDecision(rise.next, "elevated", 2 * MIN, cooldown);
    expect(ease.kind).toBe("ease");
    // Back to critical five minutes after the first critical notice: told already.
    const flap = nudgeDecision(ease.next, "critical", 5 * MIN, cooldown);
    expect(flap.kind).toBeNull();
    expect(flap.next.level).toBe("critical");
    const recover = nudgeDecision(flap.next, "ok", 6 * MIN, cooldown);
    expect(recover.kind).toBe("recover");
    expect(nudgeDecision(recover.next, "critical", 16 * MIN, cooldown).kind).toBe("rise");
  });
});

const shell = (
  id: string,
  options: {
    readonly running?: boolean;
    readonly launchedBy?: string;
    readonly launchedFrom?: string;
    readonly subagentOf?: string;
  } = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    title: id,
    status: options.running === true ? "running" : "idle",
    activityRunStatus: options.running === true ? "running" : null,
    archivedAt: null,
    deletedAt: null,
    worktreePath: "/w/" + id,
    branch: null,
    lineage: {
      parentThreadId: options.subagentOf ?? null,
      relationshipToParent: options.subagentOf === undefined ? null : "subagent",
      rootThreadId: id,
    },
    ...(options.launchedBy === undefined
      ? {}
      : {
          launchedBy: {
            kind: "launch",
            threadId: options.launchedBy,
            environmentId: options.launchedFrom ?? null,
            environmentLabel: null,
            threadTitle: null,
          },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

describe("pressureRecipients", () => {
  const shells = [
    shell("person"),
    shell("manager", { launchedBy: "person" }),
    shell("lane-a", { running: true, launchedBy: "manager" }),
    shell("lane-b", { running: true, launchedBy: "manager", launchedFrom: "env-local" }),
    shell("review", { running: true, subagentOf: "lane-a" }),
    shell("visitor", { running: true, launchedBy: "far-thread", launchedFrom: "env-remote" }),
    shell("solo", { running: true }),
  ];

  it("tells the launchers of local work and their own launchers, never the work itself", () => {
    const routed = pressureRecipients({
      host: null,
      environmentId: "env-local",
      shells,
      watches: [],
    });
    expect(routed.recipients).toEqual(["lane-a", "manager", "person"]);
    expect(routed.consumers.map((consumer) => consumer.threadId)).toEqual([
      "lane-a",
      "lane-b",
      "review",
      "visitor",
      "solo",
    ]);
  });

  it("tells the launchers following work on a remote host", () => {
    const routed = pressureRecipients({
      host: "macbook",
      environmentId: "env-local",
      shells,
      watches: [
        {
          launcherThreadId: "manager",
          host: "macbook",
          threadId: "r1",
          title: "vitest",
          pendingRuns: ["run"],
        },
        {
          launcherThreadId: "solo",
          host: "macbook",
          threadId: "r2",
          title: "done",
          pendingRuns: [],
        },
        {
          launcherThreadId: "solo",
          host: "macmini",
          threadId: "r3",
          title: "elsewhere",
          pendingRuns: ["run"],
        },
      ],
    });
    expect(routed.recipients).toEqual(["manager", "person"]);
    expect(routed.consumers.map((consumer) => consumer.threadId)).toEqual(["r1"]);
  });
});

const entry = (
  host: string | null,
  metrics: {
    readonly load: number;
    readonly running?: number;
    readonly platform?: string;
    readonly providers?: ReadonlyArray<string>;
  },
  extra: Partial<HostStatusEntry> = {},
): HostStatusEntry => ({
  host,
  reachability: "ok",
  metrics: {
    sampledAt: 0,
    cpuUtilization: 0.2,
    cpuCount: 10,
    availableMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    loadAvg: { oneMinute: metrics.load * 10, fiveMinutes: 0, fifteenMinutes: 0 },
    disk: { path: "/", availableBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    platform: metrics.platform ?? "darwin",
    threads: { running: metrics.running ?? 0, waiting: 0, queued: 0 },
    quotas: [],
    providers: (metrics.providers ?? ["codex"]).map((instanceId) => ({
      instanceId: instanceId as never,
      driver: "codex" as never,
      enabled: true,
    })),
  },
  ...extra,
});

describe("rankHosts", () => {
  const critical = {
    level: "critical" as const,
    since: "2026-10-21T00:00:00.000Z",
    reasons: [
      { signal: "load" as const, level: "critical" as const, message: "load 6.2 per core" },
    ],
    loadPerCore: 6.2,
    eventLoopDelayMs: 26_380,
  };

  it("puts idle hosts first and skips a critical one with its reason", () => {
    const ranking = rankHosts(
      [
        entry(null, { load: 6.2, running: 8 }, { pressure: critical }),
        entry("macmini", { load: 0.18 }),
        entry("studio", { load: 0.9, running: 2 }),
        entry("linux-box", { load: 1.8, running: 1 }),
      ],
      {},
      settings,
      0,
    );
    expect(ranking.candidates.map((candidate) => [candidate.host, candidate.eligible])).toEqual([
      ["macmini", true],
      ["studio", true],
      ["linux-box", true],
      [null, false],
    ]);
    expect(ranking.candidates[2]?.pressure).toBe("elevated");
    expect(ranking.candidates[3]?.reasons).toEqual(["critical: load 6.2 per core"]);
    expect(ranking.suggestion).toContain("Start the next lane on macmini");
    expect(ranking.suggestion).toContain("Avoid this machine.");
  });

  it("filters by provider instance and platform", () => {
    const ranking = rankHosts(
      [
        entry("macmini", { load: 0.1, providers: ["claude"] }),
        entry("linux-box", { load: 0.5, platform: "linux" }),
        entry("studio", { load: 0.4 }),
      ],
      { providerInstanceId: "codex" as never, platform: "darwin" },
      settings,
      0,
    );
    expect(ranking.candidates.map((candidate) => [candidate.host, candidate.reasons[0]])).toEqual([
      ["studio", "load 0.4 per core, 0 threads running or queued"],
      ["macmini", "codex is not enabled there"],
      ["linux-box", "runs linux"],
    ]);
  });
});
