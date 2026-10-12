import { EnvironmentId, compareGoatBotHomeClaims, type GoatBotHomeClaim } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  goatBotHomeAttemptKey,
  newGoatBotHomeClaim,
  pickGoatBotHomeCandidate,
  planGoatBotHomeSync,
  reduceGoatBotHomeAttempts,
  resolveGoatBotHome,
  type GoatBotHomeAttempts,
  type GoatBotHomeResolution,
  type GoatBotHomeTarget,
} from "./home.ts";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const c = EnvironmentId.make("c");
const claim = (environmentId = a, claimedAt = 100, claimId = "claim-a"): GoatBotHomeClaim => ({
  environmentId,
  claimedAt,
  claimId,
});
const target = (
  environmentId = a,
  overrides: Partial<GoatBotHomeTarget> = {},
): GoatBotHomeTarget => ({
  environmentId,
  connected: true,
  supportsHome: true,
  supportsBot: true,
  settingsLoaded: true,
  home: null,
  ...overrides,
});
const resolved = (winner = claim(), staleTargetIds = [b, c]): GoatBotHomeResolution => ({
  state: "claimed",
  claim: winner,
  homeConnected: true,
  homeSupportsBot: true,
  staleTargetIds,
});
const plan = (
  resolution: GoatBotHomeResolution,
  now = 0,
  attempts: GoatBotHomeAttempts = new Map(),
  inFlight: ReadonlySet<string> = new Set(),
) => planGoatBotHomeSync({ resolution, now, attempts, inFlight });

// Model the server's monotonic write so racing clients exercise replication in either order.
function applyWrites(
  targets: ReadonlyArray<GoatBotHomeTarget>,
  writes: ReturnType<typeof plan>["writes"],
) {
  return targets.map((entry) => {
    let home = entry.home;
    for (const write of writes) {
      if (
        write.environmentId === entry.environmentId &&
        (home === null || compareGoatBotHomeClaims(write.claim, home) > 0)
      )
        home = write.claim;
    }
    return { ...entry, home };
  });
}

describe("resolveGoatBotHome", () => {
  it("waits for every connected supporting snapshot even when another has a claim", () => {
    expect(
      resolveGoatBotHome({
        targets: [
          target(a, { home: claim() }),
          target(b, { settingsLoaded: false, home: claim(b, 200) }),
        ],
      }),
    ).toEqual({ state: "unknown" });
  });

  it("ignores loading targets that are disconnected or do not support home", () => {
    expect(
      resolveGoatBotHome({
        targets: [
          target(a),
          target(b, { connected: false, settingsLoaded: false }),
          target(c, { supportsHome: false, settingsLoaded: false }),
        ],
      }),
    ).toEqual({ state: "unclaimed" });
  });

  it("resolves empty and loaded null snapshots as unclaimed", () => {
    expect(resolveGoatBotHome({ targets: [] })).toEqual({ state: "unclaimed" });
    expect(resolveGoatBotHome({ targets: [target(a), target(b)] })).toEqual({ state: "unclaimed" });
  });

  it("selects the greatest timestamp and reports null and older connected snapshots as stale", () => {
    const winner = claim(b, 200);
    expect(
      resolveGoatBotHome({
        targets: [target(a, { home: claim() }), target(b, { home: winner }), target(c)],
      }),
    ).toEqual({
      state: "claimed",
      claim: winner,
      homeConnected: true,
      homeSupportsBot: true,
      staleTargetIds: [a, c],
    });
  });

  it("breaks equal timestamps by claim id independent of target order", () => {
    const winner = claim(b, 100, "z");
    const targets = [target(a, { home: claim(a, 100, "a") }), target(b, { home: winner })];
    expect(resolveGoatBotHome({ targets })).toEqual(resolved(winner, [a]));
    expect(resolveGoatBotHome({ targets: targets.toReversed() })).toEqual(resolved(winner, [a]));
  });

  it("ignores unsupported claims and never writes to unsupported or disconnected stale targets", () => {
    const winner = claim();
    expect(
      resolveGoatBotHome({
        targets: [
          target(a, { home: winner }),
          target(b, { supportsHome: false, home: claim(b, 500) }),
          target(c, { connected: false }),
        ],
      }),
    ).toEqual(resolved(winner, []));
  });

  it("compares values rather than snapshot object identity", () => {
    expect(
      resolveGoatBotHome({
        targets: [target(a, { home: claim() }), target(b, { home: { ...claim() } })],
      }),
    ).toEqual(resolved(claim(), []));
  });

  it("marks different home values stale even if their timestamp and claim id match", () => {
    expect(
      resolveGoatBotHome({
        targets: [target(a, { home: claim() }), target(b, { home: claim(b) })],
      }),
    ).toEqual(resolved(claim(), [b]));
  });

  it("retains a loaded offline winner and reports its connectivity separately", () => {
    const winner = claim(b, 200);
    expect(
      resolveGoatBotHome({
        targets: [target(a, { home: claim() }), target(b, { connected: false, home: winner })],
      }),
    ).toEqual({
      state: "claimed",
      claim: winner,
      homeConnected: false,
      homeSupportsBot: true,
      staleTargetIds: [a],
    });
  });

  it("reports an absent home as offline with unknown bot support", () => {
    expect(resolveGoatBotHome({ targets: [target(a, { home: claim(b) })] })).toEqual({
      state: "claimed",
      claim: claim(b),
      homeConnected: false,
      homeSupportsBot: false,
      staleTargetIds: [],
    });
  });

  it("does not require bot support to relay claims, and reports home bot support", () => {
    expect(
      resolveGoatBotHome({
        targets: [
          target(a, { supportsBot: false, home: claim() }),
          target(b, { supportsBot: false }),
        ],
      }),
    ).toEqual({
      state: "claimed",
      claim: claim(),
      homeConnected: true,
      homeSupportsBot: false,
      staleTargetIds: [b],
    });
  });
});

describe("newGoatBotHomeClaim", () => {
  it("uses injected time and identity for an initial claim", () => {
    const randomId = vi.fn(() => "new");
    expect(
      newGoatBotHomeClaim({ environmentId: b, now: 123, observedMax: null, randomId }),
    ).toEqual(claim(b, 123, "new"));
    expect(randomId).toHaveBeenCalledTimes(1);
  });

  it("advances a future observed claim when this client's clock is behind", () => {
    const future = claim(a, 50_000);
    const next = newGoatBotHomeClaim({
      environmentId: b,
      now: 100,
      observedMax: future,
      randomId: () => "a",
    });
    expect(next.claimedAt).toBe(50_001);
    expect(compareGoatBotHomeClaims(next, future)).toBeGreaterThan(0);
  });

  it("keeps advancing when the clock rolls backwards between changes", () => {
    const first = newGoatBotHomeClaim({
      environmentId: a,
      now: 1000,
      observedMax: null,
      randomId: () => "first",
    });
    const next = newGoatBotHomeClaim({
      environmentId: b,
      now: 800,
      observedMax: first,
      randomId: () => "next",
    });
    expect(next.claimedAt).toBe(1001);
  });

  it("clamps timestamps to safe nonnegative integers", () => {
    expect(
      newGoatBotHomeClaim({
        environmentId: a,
        now: Number.MAX_SAFE_INTEGER + 100,
        observedMax: null,
        randomId: () => "max",
      }).claimedAt,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      newGoatBotHomeClaim({
        environmentId: a,
        now: 0,
        observedMax: claim(a, Number.MAX_SAFE_INTEGER),
        randomId: () => "max",
      }).claimedAt,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      newGoatBotHomeClaim({
        environmentId: a,
        now: -100,
        observedMax: null,
        randomId: () => "zero",
      }).claimedAt,
    ).toBe(0);
    expect(
      newGoatBotHomeClaim({
        environmentId: a,
        now: 123.9,
        observedMax: null,
        randomId: () => "integer",
      }).claimedAt,
    ).toBe(123);
  });
});

describe("pickGoatBotHomeCandidate", () => {
  it("prefers an eligible known bot over the primary and input order", () => {
    expect(
      pickGoatBotHomeCandidate({
        targets: [target(a), target(b), target(c)],
        knownBotEnvironmentId: c,
        primaryEnvironmentId: b,
      }),
    ).toBe(c);
  });

  it.each([{ connected: false }, { supportsHome: false }, { supportsBot: false }])(
    "falls back to primary when the known bot is ineligible: %j",
    (overrides) => {
      expect(
        pickGoatBotHomeCandidate({
          targets: [target(a), target(b), target(c, overrides)],
          knownBotEnvironmentId: c,
          primaryEnvironmentId: b,
        }),
      ).toBe(b);
    },
  );

  it("never picks a remote by itself while the primary cannot run the bot", () => {
    expect(
      pickGoatBotHomeCandidate({
        targets: [target(c), target(b, { supportsBot: false }), target(a)],
        knownBotEnvironmentId: b,
        primaryEnvironmentId: b,
      }),
    ).toBeNull();
  });

  it("uses stable input order on a client with no primary", () => {
    expect(
      pickGoatBotHomeCandidate({
        targets: [target(c), target(a)],
        knownBotEnvironmentId: null,
        primaryEnvironmentId: null,
      }),
    ).toBe(c);
  });

  it("does not require loaded settings for eligibility", () => {
    expect(
      pickGoatBotHomeCandidate({
        targets: [target(a, { settingsLoaded: false })],
        knownBotEnvironmentId: null,
        primaryEnvironmentId: null,
      }),
    ).toBe(a);
  });

  it("returns null when no target is eligible", () => {
    expect(
      pickGoatBotHomeCandidate({ targets: [], knownBotEnvironmentId: a, primaryEnvironmentId: b }),
    ).toBeNull();
    expect(
      pickGoatBotHomeCandidate({
        targets: [
          target(a, { connected: false }),
          target(b, { supportsHome: false }),
          target(c, { supportsBot: false }),
        ],
        knownBotEnvironmentId: a,
        primaryEnvironmentId: b,
      }),
    ).toBeNull();
  });
});

describe("planGoatBotHomeSync", () => {
  it.each(["unknown", "unclaimed"] as const)(
    "does not write or schedule retries when %s",
    (state) => {
      expect(plan({ state })).toEqual({ writes: [], nextWakeAt: null });
    },
  );

  it("writes only stale targets with the winning non-null claim", () => {
    expect(plan(resolved())).toEqual({
      writes: [
        { environmentId: b, claim: claim() },
        { environmentId: c, claim: claim() },
      ],
      nextWakeAt: null,
    });
    expect(plan(resolved(claim(), []))).toEqual({ writes: [], nextWakeAt: null });
  });

  it("skips in-flight writes without scheduling a busy loop", () => {
    expect(plan(resolved(), 0, new Map(), new Set([goatBotHomeAttemptKey("claim-a", b)]))).toEqual({
      writes: [{ environmentId: c, claim: claim() }],
      nextWakeAt: null,
    });
  });

  it.each([
    [1, 2_000],
    [2, 8_000],
    [3, 30_000],
    [4, 60_000],
    [10, 60_000],
  ])("retries after failure %i at exactly %i ms", (failures, delay) => {
    const attempts = new Map([
      [goatBotHomeAttemptKey("claim-a", b), { failures, lastAttemptAt: 500 }],
    ]);
    expect(plan(resolved(claim(), [b]), 500 + delay - 1, attempts)).toEqual({
      writes: [],
      nextWakeAt: 500 + delay,
    });
    expect(plan(resolved(claim(), [b]), 500 + delay, attempts)).toEqual({
      writes: [{ environmentId: b, claim: claim() }],
      nextWakeAt: null,
    });
  });

  it("continues successful targets while partial failures use the earliest pending wake", () => {
    const attempts = new Map([
      [goatBotHomeAttemptKey("claim-a", b), { failures: 2, lastAttemptAt: 1000 }],
      [goatBotHomeAttemptKey("claim-a", c), { failures: 1, lastAttemptAt: 2000 }],
    ]);
    expect(plan(resolved(claim(), [a, b, c]), 3000, attempts)).toEqual({
      writes: [{ environmentId: a, claim: claim() }],
      nextWakeAt: 4000,
    });
    expect(plan(resolved(), 4000, attempts)).toEqual({
      writes: [{ environmentId: c, claim: claim() }],
      nextWakeAt: 9000,
    });
    expect(
      plan(resolved(), 3000, attempts, new Set([goatBotHomeAttemptKey("claim-a", c)])),
    ).toEqual({ writes: [], nextWakeAt: 9000 });
  });

  it("ignores obsolete attempts and in-flight keys when a new winner arrives", () => {
    const attempts = new Map([
      [goatBotHomeAttemptKey("old", b), { failures: 10, lastAttemptAt: 999_000 }],
    ]);
    expect(
      plan(resolved(claim(), [b]), 0, attempts, new Set([goatBotHomeAttemptKey("old", b)])),
    ).toEqual({ writes: [{ environmentId: b, claim: claim() }], nextWakeAt: null });
  });
});

describe("retry bookkeeping", () => {
  it("records starts and failures immutably, preserving failure counts on retry start", () => {
    const empty: GoatBotHomeAttempts = new Map();
    const start = reduceGoatBotHomeAttempts(empty, {
      type: "start",
      claimId: "claim-a",
      environmentId: b,
      now: 100,
    });
    const failed = reduceGoatBotHomeAttempts(start, {
      type: "failure",
      claimId: "claim-a",
      environmentId: b,
      now: 150,
    });
    const retry = reduceGoatBotHomeAttempts(failed, {
      type: "start",
      claimId: "claim-a",
      environmentId: b,
      now: 2150,
    });
    const key = goatBotHomeAttemptKey("claim-a", b);
    expect(empty.size).toBe(0);
    expect(start.get(key)).toEqual({ failures: 0, lastAttemptAt: 100 });
    expect(failed.get(key)).toEqual({ failures: 1, lastAttemptAt: 150 });
    expect(retry.get(key)).toEqual({ failures: 1, lastAttemptAt: 2150 });
    const failedAgain = reduceGoatBotHomeAttempts(retry, {
      type: "failure",
      claimId: "claim-a",
      environmentId: b,
      now: 2200,
    });
    expect(plan(resolved(claim(), [b]), 2200, failedAgain).nextWakeAt).toBe(10_200);
  });

  it("clears successful targets without changing other retries", () => {
    const attempts = new Map([
      [goatBotHomeAttemptKey("claim-a", b), { failures: 1, lastAttemptAt: 100 }],
      [goatBotHomeAttemptKey("claim-a", c), { failures: 2, lastAttemptAt: 200 }],
    ]);
    const next = reduceGoatBotHomeAttempts(attempts, {
      type: "success",
      claimId: "claim-a",
      environmentId: b,
    });
    expect(next.has(goatBotHomeAttemptKey("claim-a", b))).toBe(false);
    expect(next.get(goatBotHomeAttemptKey("claim-a", c))).toEqual(
      attempts.get(goatBotHomeAttemptKey("claim-a", c)),
    );
    expect(attempts.size).toBe(2);
  });

  it("drops obsolete attempts on claim change and cancels pending old wakes", () => {
    const oldClaim = claim(a, 100, "old");
    const nextClaim = claim(b, 200, "new");
    const attempts = new Map([
      [goatBotHomeAttemptKey("old", b), { failures: 3, lastAttemptAt: 100 }],
      [goatBotHomeAttemptKey("new", c), { failures: 1, lastAttemptAt: 200 }],
    ]);
    expect(plan(resolved(oldClaim, [b]), 100, attempts).nextWakeAt).toBe(30_100);
    const next = reduceGoatBotHomeAttempts(attempts, { type: "claim-changed", claimId: "new" });
    expect([...next.keys()]).toEqual([goatBotHomeAttemptKey("new", c)]);
    expect(plan(resolved(nextClaim, [c]), 200, next).nextWakeAt).toBe(2200);
    expect(reduceGoatBotHomeAttempts(next, { type: "claim-changed", claimId: null }).size).toBe(0);
    expect(attempts.size).toBe(2);
  });
});

describe("cluster convergence", () => {
  it.each([false, true])(
    "converges when two clients claim concurrently (reverse writes: %s)",
    (reverse) => {
      const initial = [target(a), target(b)];
      const first = newGoatBotHomeClaim({
        environmentId: a,
        now: 100,
        observedMax: null,
        randomId: () => "a",
      });
      const winner = newGoatBotHomeClaim({
        environmentId: b,
        now: 100,
        observedMax: null,
        randomId: () => "z",
      });
      const writes = [
        ...plan(resolveGoatBotHome({ targets: [target(a, { home: first }), target(b)] })).writes,
        ...plan(resolveGoatBotHome({ targets: [target(a), target(b, { home: winner })] })).writes,
      ];
      let cluster = applyWrites(initial, reverse ? writes.toReversed() : writes);
      for (const clientTargets of [cluster, cluster.toReversed()]) {
        const resolution = resolveGoatBotHome({ targets: clientTargets });
        expect(resolution).toMatchObject({ state: "claimed", claim: winner });
        cluster = applyWrites(cluster, plan(resolution).writes);
      }
      expect(cluster.map((entry) => entry.home)).toEqual([winner, winner]);
      expect(plan(resolveGoatBotHome({ targets: cluster })).writes).toEqual([]);
    },
  );

  it("replicates a delayed winner immediately despite retries for the older claim", () => {
    const old = claim(a, 100, "old");
    const winner = claim(b, 200, "winner");
    const before = [target(a, { home: old }), target(b, { home: old }), target(c)];
    const attempts = new Map([
      [goatBotHomeAttemptKey("old", c), { failures: 4, lastAttemptAt: 100 }],
    ]);
    expect(plan(resolveGoatBotHome({ targets: before }), 100, attempts).nextWakeAt).toBe(60_100);
    const later = before.map((entry) =>
      entry.environmentId === b ? { ...entry, home: winner } : entry,
    );
    const sync = plan(resolveGoatBotHome({ targets: later }), 101, attempts);
    expect(sync).toEqual({
      writes: [
        { environmentId: a, claim: winner },
        { environmentId: c, claim: winner },
      ],
      nextWakeAt: null,
    });
    expect(resolveGoatBotHome({ targets: applyWrites(later, sync.writes) })).toEqual(
      resolved(winner, []),
    );
  });
});
