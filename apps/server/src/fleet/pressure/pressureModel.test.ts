// @effect-diagnostics nodeBuiltinImport:off -- reads one checked-in stall log fixture.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import type {
  HostPressureLevel,
  HostStatusEntry,
  OrchestrationV2ThreadShell,
} from "@goat/contracts";

import {
  classify,
  initialPressureState,
  nudgeDecision,
  NOTHING_ANNOUNCED,
  pressureRecipients,
  rankHosts,
  resolvePressureSettings,
  stallPressure,
  stepPressure,
  toHostPressure,
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

  it("leaves server stalls to stallPressure", () => {
    expect(classify({ ...calm, eventLoopDelayMs: 26_380 }, settings).level).toBe("ok");
  });

  it("uses configured thresholds over the defaults", () => {
    const strict = resolvePressureSettings({ elevatedLoadPerCore: 0.5 });
    expect(classify(load(0.6), strict).level).toBe("elevated");
    expect(strict.criticalLoadPerCore).toBe(3);
  });
});

describe("stallPressure", () => {
  const stalls = (...ms: ReadonlyArray<number>) =>
    ms.map((value, index) => ({ at: index * MIN, ms: value }));

  it("never counts one stall and names repeated ones", () => {
    expect(stallPressure(stalls(3_600), settings)).toEqual({ level: "ok", reason: null });
    expect(stallPressure(stalls(2_600, 3_000, 2_500), settings)).toEqual({
      level: "elevated",
      reason: {
        signal: "event_loop",
        level: "elevated",
        message: "GOAT server stalled 3 times over 2.5 s in 10 min (longest 3 s)",
      },
    });
    expect(stallPressure(stalls(5_200, 2_100, 6_400), settings).level).toBe("critical");
  });

  it("takes one severe stall as critical", () => {
    expect(stallPressure(stalls(26_380), settings).reason?.message).toBe(
      "GOAT server stalled 26.4 s (threshold 15 s)",
    );
  });
});

describe("stepPressure", () => {
  it("rises only after the reading holds for sustainMs", () => {
    // 0 to 150 s are not yet three minutes; 180 s is.
    expect(levels(Array.from({ length: 7 }, () => load(2)))).toEqual([
      ...Array.from({ length: 6 }, () => "ok"),
      "elevated",
    ]);
  });

  it("ignores a reading that flaps across the threshold", () => {
    expect(levels(Array.from({ length: 10 }, (_, index) => load(index % 2 === 0 ? 2 : 1)))).toEqual(
      Array.from({ length: 10 }, () => "ok"),
    );
  });

  it("holds a level until readings clear the loosened threshold for recoverMs", () => {
    let state = initialPressureState(0);
    for (let at = 0; at <= 3 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(2), settings, at);
    expect(state.level).toBe("elevated");
    // 1.3 per core is under 1.5 but above 1.5 × 0.8, so the host stays elevated.
    for (let at = 3.5 * MIN; at <= 10 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(1.3), settings, at);
    expect(state.level).toBe("elevated");
    const clearing = [];
    for (let at = 10.5 * MIN; at <= 15.5 * MIN; at += 30 * SECOND) {
      state = stepPressure(state, load(1), settings, at);
      clearing.push(state.level);
    }
    expect(clearing).toEqual([...Array.from({ length: 10 }, () => "elevated"), "ok"]);
  });

  it("records a single stall spike without leaving ok", () => {
    let state = initialPressureState(0);
    const seen = new Set<string>();
    for (let at = 0; at <= 10 * MIN; at += 30 * SECOND) {
      const stall = at === MIN ? 3_600 : null;
      state = stepPressure(state, { ...calm, eventLoopDelayMs: stall }, settings, at);
      seen.add(state.level);
      if (at === 2 * MIN) expect(toHostPressure(state).eventLoopDelayMs).toBe(3_600);
    }
    expect([...seen]).toEqual(["ok"]);
  });

  it("goes elevated once stalls repeat and falls recoverMs after they stop repeating", () => {
    let state = initialPressureState(0);
    const stallAt = new Set([0, 4 * MIN, 8 * MIN]);
    const changes: Array<readonly [number, string]> = [];
    for (let at = 0; at <= 25 * MIN; at += 30 * SECOND) {
      const before = state.level;
      const stall = stallAt.has(at) ? 2_700 : null;
      state = stepPressure(state, { ...calm, eventLoopDelayMs: stall }, settings, at);
      if (state.level !== before) changes.push([at / MIN, state.level]);
    }
    // The third stall raises it; the first leaves the window at 10 min, then five clear minutes.
    expect(changes).toEqual([
      [8, "elevated"],
      [15, "ok"],
    ]);
  });

  it("goes critical on a severe stall and steps down as readings clear", () => {
    let state = stepPressure(
      initialPressureState(0),
      { ...load(2), eventLoopDelayMs: 26_380 },
      settings,
      0,
    );
    expect(state.level).toBe("critical");
    expect(state.reasons.map((reason) => reason.signal)).toEqual(["load", "event_loop"]);
    for (let at = 30 * SECOND; at < 15 * MIN; at += 30 * SECOND)
      state = stepPressure(state, load(2), settings, at);
    expect(state.level).toBe("critical");
    state = stepPressure(state, load(2), settings, 15 * MIN);
    // The stall left the window at 10 min and load is still elevated: critical eases 5 min later.
    expect(state.level).toBe("elevated");
    expect(state.since).toBe(15 * MIN);
  });
});

describe("nudgeDecision", () => {
  /** Feeds levels at minute marks and describes what each change writes. */
  const replay = (steps: ReadonlyArray<readonly [number, HostPressureLevel]>) => {
    let announced = NOTHING_ANNOUNCED;
    return steps.flatMap(([minute, level]) => {
      const { next, nudge } = nudgeDecision(announced, level, minute * MIN, settings);
      announced = next;
      if (nudge === null) return [];
      const row =
        nudge.row === null
          ? ""
          : (nudge.row.opened ? " opens row " : " updates row ") + Number(nudge.row.id) / MIN;
      return [minute + " " + nudge.kind + row + (nudge.wake ? " + wake" : "")];
    });
  };

  it("opens one row per cooldown and rewrites it in place while a host flaps", () => {
    const writes = replay(
      Array.from({ length: 20 }, (_, index) => [index * 6, index % 2 === 0 ? "elevated" : "ok"]),
    );
    expect(writes.filter((write) => write.includes("opens"))).toEqual([
      "0 rise opens row 0",
      "48 rise opens row 48",
      "96 rise opens row 96",
    ]);
    expect(writes).toHaveLength(20);
    expect(writes.filter((write) => write.includes("wake"))).toEqual([]);
  });

  it("wakes at once when a host gets worse, even inside the cooldown", () => {
    expect(
      replay([
        [0, "elevated"],
        [2, "critical"],
        [10, "elevated"],
        [20, "critical"],
        [40, "ok"],
        [50, "critical"],
      ]),
    ).toEqual([
      "0 rise opens row 0",
      "2 rise updates row 0 + wake",
      "10 ease updates row 0",
      "20 rise updates row 0",
      "40 recover updates row 0",
      "50 rise opens row 50 + wake",
    ]);
  });

  it("writes nothing for a level that is off, or for recovery without a row", () => {
    const quiet = { ...settings, elevatedDelivery: "off" as const };
    const rise = nudgeDecision(NOTHING_ANNOUNCED, "elevated", 0, quiet);
    expect(rise.nudge).toBeNull();
    expect(nudgeDecision(rise.next, "ok", 10 * MIN, quiet).nudge).toBeNull();
  });
});

describe("replaying the 2026-10-22 13:37-15:26Z stall log", () => {
  // Rebuilt from that afternoon's notices: 2.2-3.6 s stalls every 6-12 min while tests ran, loop
  // utilization 0.2-0.5, rss about 500 MB, and the machine itself under its load thresholds.
  const stalls = NodeFS.readFileSync(
    new URL("./fixtures/event-loop-stalls-2026-10-22.ndjson", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly time: string; readonly delayMaxMs: number })
    .map((line) => ({ at: Date.parse(line.time), ms: line.delayMaxMs }));

  it("keeps the host ok and writes nothing", () => {
    const start = Date.parse("2026-10-22T13:30:00Z");
    let state = initialPressureState(start);
    let announced = NOTHING_ANNOUNCED;
    const writes = [];
    for (let at = start; at <= start + 120 * MIN; at += 30 * SECOND) {
      const stall = stalls.find((entry) => entry.at > at - 30 * SECOND && entry.at <= at);
      state = stepPressure(
        state,
        { ...load(0.9), eventLoopDelayMs: stall?.ms ?? null },
        settings,
        at,
      );
      const decision = nudgeDecision(announced, state.level, at, settings);
      announced = decision.next;
      if (decision.nudge !== null) writes.push(decision.nudge);
    }
    expect(stalls).toHaveLength(13);
    expect(state.level).toBe("ok");
    expect(writes).toEqual([]);
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
