import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

import {
  type GoalObservation,
  LAUNCH_GRACE_MS,
  MAX_ACTIONS_PER_GOAL,
  newWorker,
  ORPHAN_SLOT_BASE,
  planGoal,
  repairWorkers,
  type SlotObservation,
} from "./goalPlan.ts";
import { WorkerRecord } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";

const NOW = Date.parse("2026-10-20T01:00:00.000Z");
const decodeWorker = Schema.decodeUnknownSync(WorkerRecord);

const observe = (overrides: Partial<GoalObservation> = {}): GoalObservation => ({
  now: NOW,
  owner: { available: true },
  workers: new Map(),
  launchClaims: new Map(),
  unmovedReschedules: new Set(),
  pendingMoves: new Map(),
  switchedFallbacks: new Set(),
  pullRequests: new Map(),
  issues: new Map(),
  turns: 0,
  firstClaimAt: null,
  drainingHosts: new Set(),
  refusedReschedules: new Set(),
  ...overrides,
});

const running = (
  goal: ReturnType<typeof testGoal>,
  slot: number,
  extra: Partial<WorkerRecord> = {},
): WorkerRecord => ({
  ...newWorker(goal, slot, null),
  threadId: ThreadId.make("thread:w" + slot),
  branch: "goal/test/s" + slot + "-a1",
  state: "running",
  ...extra,
});

const seen = (
  overrides: Partial<Extract<SlotObservation, { kind: "seen" }>> = {},
): SlotObservation => ({
  kind: "seen",
  health: { _tag: "healthy" },
  terminal: true,
  runId: RunId.make("run:1"),
  runStatus: "completed",
  lastActivityAt: "2026-10-20T00:59:00.000Z",
  result: { reported: false, pullRequest: null },
  ...overrides,
});

describe("planGoal", () => {
  it("launches each missing slot once per pass, capped per goal, under the design's ids", () => {
    const goal = testGoal("goal_a", {
      spec: testSpec({
        workers: { ...testSpec().workers, count: 5 },
        limits: { ...testSpec().limits, maxWorkers: 5 },
      }),
    });
    const plan = planGoal(goal, [], observe());
    expect(plan.actions).toHaveLength(MAX_ACTIONS_PER_GOAL);
    expect(plan.actions[0]).toEqual({
      type: "launch",
      slot: 0,
      attempt: 1,
      actionId: "goal:goal_a:s0:a1:launch",
    });
    expect(plan.truncated).toBe(true);
    expect(planGoal(goal, [], observe()).actions).toEqual(plan.actions);
  });

  it("never resends a claimed launch: it looks it up, then moves to the next attempt after the grace", () => {
    const goal = testGoal("goal_b");
    const worker = newWorker(goal, 0, null);
    const fresh = planGoal(
      goal,
      [worker],
      observe({
        launchClaims: new Map([
          [worker.launchClientRequestId, { claimedAt: NOW - 1000, settled: false }],
        ]),
      }),
    );
    expect(fresh.actions).toEqual([
      {
        type: "resolve_launch",
        slot: 0,
        attempt: 1,
        actionId: "goal:goal_b:s0:a1:launch",
        expired: false,
      },
    ]);
    expect(fresh.workers[0]!.state).toBe("launch_unknown");
    const late = planGoal(
      goal,
      [worker],
      observe({
        launchClaims: new Map([
          [worker.launchClientRequestId, { claimedAt: NOW - LAUNCH_GRACE_MS - 1, settled: false }],
        ]),
      }),
    );
    expect(late.actions[0]).toMatchObject({ type: "resolve_launch", expired: true });
  });

  it("follows up once per run when CI fails on the worker's PR, using only numbers in the text", () => {
    const goal = testGoal("goal_c", { spec: testSpec({ doneWhen: [{ type: "checks_green" }] }) });
    const worker = running(goal, 0);
    const observation = observe({
      workers: new Map([[0, seen({ result: { reported: true, pullRequest: 41 } })]]),
      pullRequests: new Map([[41, { kind: "seen", state: "open", checks: "failing" }]]),
    });
    const plan = planGoal(goal, [worker], observation);
    expect(plan.actions).toEqual([
      {
        type: "followup",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        actionId: "goal:goal_c:s0:a1:run:1:followup",
        message:
          "CI failed on PR #41. Read the failing checks on the pull request, fix them, push, and report again.",
      },
    ]);
    const nudged = { ...plan.workers[0]!, followUps: 1, followedUpRunId: RunId.make("run:1") };
    expect(planGoal(goal, [nudged], observation).actions).toEqual([]);
  });

  it("recovers a failed run, waits on people, and leaves a run a person stopped alone", () => {
    const goal = testGoal("goal_d", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 3 } }),
    });
    const plan = planGoal(
      goal,
      [running(goal, 0), running(goal, 1), running(goal, 2)],
      observe({
        workers: new Map([
          [
            0,
            seen({
              runStatus: "failed",
              health: { _tag: "failed", failureClass: "usage_limit", runId: RunId.make("run:1") },
            }),
          ],
          [1, seen({ terminal: false, runStatus: "running", health: { _tag: "waiting" } })],
          [2, seen({ runStatus: "interrupted" })],
        ]),
      }),
    );
    expect(plan.actions).toEqual([
      {
        type: "recover",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        reason: "failed",
        failureClass: "usage_limit",
      },
    ]);
    expect(plan.workers.map((worker) => worker.state)).toEqual([
      "running",
      "needs_human",
      "needs_human",
    ]);
  });

  it("steers a stall once, then asks for a reschedule", () => {
    const goal = testGoal("goal_e");
    const stalled = seen({
      terminal: false,
      runStatus: "running",
      health: { _tag: "stalled", idleMs: 1_500_000 },
    });
    const first = planGoal(goal, [running(goal, 0)], observe({ workers: new Map([[0, stalled]]) }));
    expect(first.actions[0]).toMatchObject({ type: "followup" });
    const steered = {
      ...first.workers[0]!,
      steeredRunId: RunId.make("run:1"),
      followedUpRunId: RunId.make("run:1"),
    };
    const second = planGoal(goal, [steered], observe({ workers: new Map([[0, stalled]]) }));
    expect(second.actions).toEqual([
      {
        type: "recover",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        reason: "stalled",
        failureClass: "unknown",
      },
    ]);
  });

  it("stops orphaned earlier attempts before launching the attempts that wait on them", () => {
    const goal = testGoal("goal_order", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 3 } }),
    });
    const successors = [0, 1, 2].map((slot) => newWorker(goal, slot, null, 2));
    const orphans = [0, 1, 2].map((slot) => running(goal, ORPHAN_SLOT_BASE + slot));
    const plan = planGoal(
      goal,
      [...successors, ...orphans],
      observe({
        workers: new Map(
          orphans.map((worker) => [
            worker.slot,
            seen({ terminal: false, runStatus: "running", result: null }),
          ]),
        ),
      }),
    );
    expect(
      plan.actions.map((action) => [action.type, "slot" in action ? action.slot : null]),
    ).toEqual([
      ["interrupt", ORPHAN_SLOT_BASE],
      ["interrupt", ORPHAN_SLOT_BASE + 1],
      ["interrupt", ORPHAN_SLOT_BASE + 2],
    ]);
    expect(plan.truncated).toBe(true);
  });

  it("gives each run of an orphan its own interrupt, so a run that started later is stopped too", () => {
    const goal = testGoal("goal_reruns");
    const orphan = running(goal, ORPHAN_SLOT_BASE);
    const idFor = (runId: string) =>
      planGoal(
        goal,
        [orphan],
        observe({
          workers: new Map([
            [
              ORPHAN_SLOT_BASE,
              seen({ terminal: false, runStatus: "running", runId: RunId.make(runId) }),
            ],
          ]),
        }),
      ).actions.find((action) => action.type === "interrupt");
    expect(idFor("run:1")).toMatchObject({
      actionId: "goal:goal_reruns:s10000:a1:run:1:interrupt",
    });
    expect(idFor("run:2")).toMatchObject({
      actionId: "goal:goal_reruns:s10000:a1:run:2:interrupt",
    });
  });

  it("succeeds when every doneWhen holds and stops acting", () => {
    const goal = testGoal("goal_f", {
      spec: testSpec({
        doneWhen: [{ type: "pull_requests_merged" }, { type: "thread_reported_result" }],
      }),
    });
    const plan = planGoal(
      goal,
      [running(goal, 0)],
      observe({
        workers: new Map([[0, seen({ result: { reported: true, pullRequest: 7 } })]]),
        pullRequests: new Map([[7, { kind: "seen", state: "merged", checks: "passing" }]]),
      }),
    );
    expect(plan.status.phase).toBe("succeeded");
    expect(plan.status.conditions.find((condition) => condition.type === "Done")).toMatchObject({
      status: "True",
      observedGeneration: 1,
    });
    expect(plan.actions).toEqual([]);
  });

  it("blocks without acting on a spent budget, a paused spec, or lost owner authority", () => {
    const goal = testGoal("goal_g");
    expect(planGoal(goal, [], observe({ turns: 40 })).status).toMatchObject({ phase: "blocked" });
    expect(planGoal(goal, [], observe({ turns: 40 })).actions).toEqual([]);
    const paused = testGoal("goal_g", { spec: testSpec({ paused: true }) });
    expect(planGoal(paused, [], observe())).toMatchObject({
      actions: [],
      status: { phase: "paused" },
    });
    const orphan = planGoal(
      goal,
      [],
      observe({ owner: { available: false, reason: "The owner thread was deleted." } }),
    );
    expect(orphan).toMatchObject({ actions: [], status: { phase: "blocked" } });
    expect(orphan.status.conditions.find((c) => c.type === "Blocked")).toMatchObject({
      status: "True",
      reason: "OwnerAuthorityLost",
    });
  });

  it("interrupts slots the spec dropped and, when deleting, every live slot before removing the row", () => {
    const goal = testGoal("goal_h", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 1 } }),
    });
    const live = seen({ terminal: false, runStatus: "running" });
    const shrink = planGoal(
      goal,
      [running(goal, 0), running(goal, 1)],
      observe({
        workers: new Map([
          [0, live],
          [1, live],
        ]),
      }),
    );
    expect(shrink.actions).toEqual([
      { type: "interrupt", slot: 1, attempt: 1, actionId: "goal:goal_h:s1:a1:run:1:interrupt" },
    ]);
    // It stays live until the interrupt is confirmed.
    expect(shrink.workers[1]!.state).toBe("running");
    const deleting = testGoal("goal_h", { deletionRequestedAt: "2026-10-20T00:30:00.000Z" });
    expect(
      planGoal(deleting, [running(deleting, 0)], observe({ workers: new Map([[0, live]]) }))
        .actions,
    ).toEqual([
      { type: "interrupt", slot: 0, attempt: 1, actionId: "goal:goal_h:s0:a1:run:1:interrupt" },
    ]);
    expect(
      planGoal(deleting, [running(deleting, 0)], observe({ workers: new Map([[0, seen()]]) }))
        .actions,
    ).toEqual([{ type: "delete_row" }]);
  });
  it("keeps dropped slots until their interrupts land, even past one pass's limit", () => {
    const goal = testGoal("goal_i", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 0 } }),
    });
    const live = seen({ terminal: false, runStatus: "running" });
    const previous = [0, 1, 2, 3, 4].map((slot) => running(goal, slot));
    const plan = planGoal(
      goal,
      previous,
      observe({ workers: new Map(previous.map((w) => [w.slot, live])) }),
    );
    expect(plan.actions).toHaveLength(MAX_ACTIONS_PER_GOAL);
    expect(plan.truncated).toBe(true);
    expect(plan.workers.map((worker) => worker.state)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "running",
    ]);
    const stopped = planGoal(
      goal,
      previous,
      observe({ workers: new Map(previous.map((w) => [w.slot, seen()])) }),
    );
    expect(stopped.workers.every((worker) => worker.state === "superseded")).toBe(true);
    const paused = testGoal("goal_i", {
      spec: testSpec({ paused: true, workers: { ...testSpec().workers, count: 0 } }),
    });
    expect(
      planGoal(paused, previous, observe({ workers: new Map(previous.map((w) => [w.slot, live])) }))
        .actions,
    ).toEqual([]);
  });

  it("keeps a deleting goal while any attempt cannot be confirmed stopped", () => {
    const deleting = testGoal("goal_j", { deletionRequestedAt: "2026-10-20T00:30:00.000Z" });
    const unreadable = planGoal(
      deleting,
      [running(deleting, 0)],
      observe({ workers: new Map([[0, { kind: "unknown", message: "host down" }]]) }),
    );
    expect(unreadable.actions).toEqual([]);
    expect(unreadable.status.phase).toBe("deleting");
    const unclear = newWorker(deleting, 0, null);
    const claimed = planGoal(
      deleting,
      [unclear],
      observe({
        launchClaims: new Map([
          [unclear.launchClientRequestId, { claimedAt: NOW - 1000, settled: false }],
        ]),
      }),
    );
    expect(claimed.actions).toEqual([
      {
        type: "resolve_launch",
        slot: 0,
        attempt: 1,
        actionId: "goal:goal_j:s0:a1:launch",
        expired: false,
      },
    ]);
  });

  it("runs the wall-clock budget from the first claim even if status never recorded it", () => {
    const goal = testGoal("goal_k", {
      spec: testSpec({ limits: { ...testSpec().limits, maxWallClockMs: 60_000 } }),
    });
    const plan = planGoal(goal, [], observe({ firstClaimAt: NOW - 120_000 }));
    expect(plan.actions).toEqual([]);
    expect(
      plan.status.conditions.find((condition) => condition.type === "BudgetExhausted"),
    ).toMatchObject({ status: "True" });
  });
  it("still resolves the unclear launch of a dropped slot, so deletion is not stuck (P2-6)", () => {
    const goal = testGoal("goal_l", {
      spec: testSpec({ workers: { ...testSpec().workers, count: 0 } }),
    });
    const unclear = { ...newWorker(goal, 0, null), state: "launch_unknown" as const };
    const claims = new Map([
      [unclear.launchClientRequestId, { claimedAt: NOW - 1000, settled: false }],
    ]);
    expect(planGoal(goal, [unclear], observe({ launchClaims: claims })).actions).toEqual([
      {
        type: "resolve_launch",
        slot: 0,
        attempt: 1,
        actionId: "goal:goal_l:s0:a1:launch",
        expired: false,
      },
    ]);
    const deleting = testGoal("goal_l", {
      ...goal,
      deletionRequestedAt: "2026-10-20T00:30:00.000Z",
    });
    const plan = planGoal(deleting, [unclear], observe({ launchClaims: claims }));
    expect(plan.actions.map((action) => action.type)).toEqual(["resolve_launch"]);
  });

  it("relaunches a slot the spec drops and then wants again, as a new attempt (P2-8)", () => {
    const goal = testGoal("goal_m");
    const superseded = { ...running(goal, 0), state: "superseded" as const };
    expect(planGoal(goal, [superseded], observe()).actions).toEqual([
      { type: "launch", slot: 0, attempt: 2, actionId: "goal:goal_m:s0:a2:launch" },
    ]);
  });

  it("rebuilds slots from launch records that outlived a status write (P1-3, P1-4)", () => {
    const goal = testGoal("goal_n");
    const launch = (attempt: number, threadId: string | null, settledAt: string | null = null) => ({
      actionId: "goal:goal_n:s0:a" + attempt + ":launch",
      slot: 0,
      claimedAt: "2026-10-20T00:00:00.000Z",
      settledAt,
      outcome: threadId === null ? null : "launched",
      host: null,
      threadId,
    });
    // No slot record at all: the launched thread becomes slot 0.
    expect(
      repairWorkers(goal, [], [launch(1, "thread:a", "2026-10-20T00:00:01.000Z")]),
    ).toMatchObject([
      // With its launch's branch, so a later move resumes from the worker's work (#1451).
      { slot: 0, attempt: 1, threadId: "thread:a", branch: "goal/test/s0-a1", state: "running" },
    ]);
    // A claimed launch with no outcome stays unclear instead of being forgotten.
    expect(repairWorkers(goal, [], [launch(1, null)])).toMatchObject([
      { slot: 0, threadId: null, state: "launch_unknown" },
    ]);
    // An earlier attempt's thread, after the slot moved on, becomes an orphan slot to stop.
    const second = {
      ...newWorker(goal, 0, null, 2),
      threadId: ThreadId.make("thread:b"),
      state: "running" as const,
    };
    const rebuilt = repairWorkers(
      goal,
      [second],
      [launch(1, "thread:a", "2026-10-20T00:00:01.000Z")],
    );
    expect(rebuilt.map((worker) => [worker.slot, worker.threadId])).toEqual([
      [0, "thread:b"],
      [ORPHAN_SLOT_BASE, "thread:a"],
    ]);
    const live = seen({ terminal: false, runStatus: "running" });
    expect(
      planGoal(
        goal,
        rebuilt,
        observe({
          workers: new Map([
            [0, live],
            [ORPHAN_SLOT_BASE, live],
          ]),
        }),
      ).actions,
    ).toEqual([
      {
        type: "interrupt",
        slot: ORPHAN_SLOT_BASE,
        attempt: 1,
        actionId: "goal:goal_n:s10000:a1:run:1:interrupt",
      },
    ]);
  });
  it("still looks up an unclear launch once the goal is done, so its thread can be stopped (P2-3)", () => {
    const goal = testGoal("goal_o", {
      spec: testSpec({
        workers: { ...testSpec().workers, count: 0 },
        targets: [{ type: "pull_request", number: 7 }],
        doneWhen: [{ type: "pull_requests_merged" }],
      }),
    });
    const unclear = { ...newWorker(goal, 0, null), state: "launch_unknown" as const };
    const plan = planGoal(
      goal,
      [unclear],
      observe({
        launchClaims: new Map([
          [unclear.launchClientRequestId, { claimedAt: NOW - 1000, settled: false }],
        ]),
        pullRequests: new Map([[7, { kind: "seen", state: "merged", checks: "passing" }]]),
      }),
    );
    expect(plan.status.phase).toBe("succeeded");
    expect(plan.actions).toEqual([
      {
        type: "resolve_launch",
        slot: 0,
        attempt: 1,
        actionId: "goal:goal_o:s0:a1:launch",
        expired: false,
      },
    ]);
  });

  it("resumes a usage-limited run once its limit resets, and only once (P2-4)", () => {
    const goal = testGoal("goal_p");
    // The fallback already handled this run (none configured), so followedUpRunId is set.
    const handled = running(goal, 0, { followedUpRunId: RunId.make("run:1") });
    const limited = (resetAt: string) =>
      seen({
        runStatus: "failed",
        health: { _tag: "failed", failureClass: "usage_limit", runId: RunId.make("run:1") },
        usageLimitResetAt: resetAt,
        result: null,
      });
    const before = planGoal(
      goal,
      [handled],
      observe({ workers: new Map([[0, limited("2026-10-20T02:00:00.000Z")]]) }),
    );
    expect(before.actions).toEqual([]);
    expect(before.workers[0]!.note).toContain("Waits for its usage limit to reset");
    const after = planGoal(
      goal,
      [handled],
      observe({ workers: new Map([[0, limited("2026-10-20T00:30:00.000Z")]]) }),
    );
    expect(after.actions).toEqual([
      {
        type: "resume",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        actionId: "goal:goal_p:s0:a1:run:1:resume",
      },
    ]);
    const resumed = { ...handled, resumedRunId: RunId.make("run:1") };
    expect(
      planGoal(
        goal,
        [resumed],
        observe({ workers: new Map([[0, limited("2026-10-20T00:30:00.000Z")]]) }),
      ).actions,
    ).toEqual([]);
  });

  it("recovers once a failed run an earlier controller marked followed up after a refused move (#1452)", () => {
    const goal = testGoal("goal_q");
    // The row the controller before #1472 left behind: the run is recorded as followed up both
    // when its reschedule was refused and when a same-thread fallback was sent.
    const { recoveredRunId: _absent, ...legacy } = running(goal, 0);
    const followedUp = decodeWorker({
      ...legacy,
      followedUpRunId: "run:1",
      lastRunId: "run:1",
    });
    const failed = seen({
      runStatus: "failed",
      health: { _tag: "failed", failureClass: "unknown", runId: RunId.make("run:1") },
      result: null,
    });
    const refused = observe({
      workers: new Map([[0, failed]]),
      unmovedReschedules: new Set(["goal:goal_q:s0:a1:run:1:reschedule"]),
    });
    expect(planGoal(goal, [followedUp], refused).actions).toEqual([
      {
        type: "recover",
        slot: 0,
        attempt: 1,
        runId: RunId.make("run:1"),
        reason: "failed",
        failureClass: "unknown",
      },
    ]);
    // A sent fallback whose message waits held behind the failed run still shows that run.
    expect(
      planGoal(goal, [followedUp], observe({ workers: new Map([[0, failed]]) })).actions,
    ).toEqual([]);
    // Once this controller records the recovery's outcome, the run is not recovered again.
    const settled = { ...followedUp, recoveredRunId: RunId.make("run:1") };
    expect(planGoal(goal, [settled], refused).actions).toEqual([]);
  });
});

describe("moves to another host (#1451)", () => {
  const goal = testGoal("goal_mv", {
    spec: testSpec({ limits: { ...testSpec().limits, maxTurns: 2 } }),
  });
  const moveId = "goal:goal_mv:s0:a1:run:5:reschedule";
  const move = (threadId: string | null, settledAt: string | null, host = "B") => ({
    actionId: moveId,
    slot: 0,
    claimedAt: "2026-10-20T00:00:02.000Z",
    settledAt,
    outcome: settledAt === null ? null : "rescheduled",
    host,
    threadId,
  });
  const onA = running(goal, 0, { host: "A", threadId: ThreadId.make("thread:a") });
  const pending = new Map([
    [
      0,
      {
        actionId: moveId,
        attempt: 1,
        clientRequestId: "goal:goal_mv:s0:a2:launch",
        runId: RunId.make("run:5"),
      },
    ],
  ]);

  it("never turns an unsettled move into an orphan, and restores a recorded successor after a lost write", () => {
    // Unsettled: the slot keeps its attempt; the planner holds it.
    expect(repairWorkers(goal, [onA], [move(null, null)])).toEqual([onA]);
    // Settled with its thread, while the slot row still names attempt 1: the successor is the slot.
    const rebuilt = repairWorkers(goal, [onA], [move("thread:b", "2026-10-20T00:00:03.000Z")]);
    expect(
      rebuilt.map((worker) => [worker.slot, worker.attempt, worker.host, worker.threadId]),
    ).toEqual([
      [0, 2, "B", "thread:b"],
      [ORPHAN_SLOT_BASE, 1, "A", "thread:a"],
    ]);
    expect(rebuilt[0]).toMatchObject({
      branch: "goal/test/s0-a2",
      launchClientRequestId: "goal:goal_mv:s0:a2:launch",
    });
    // A successor found after the slot moved past it is stopped like any earlier attempt.
    const third = {
      ...newWorker(goal, 0, null, 3),
      host: "C",
      threadId: ThreadId.make("thread:c"),
      state: "running" as const,
    };
    expect(
      repairWorkers(goal, [third], [move("thread:b", "2026-10-20T00:00:03.000Z")]).map((worker) => [
        worker.slot,
        worker.threadId,
      ]),
    ).toEqual([
      [0, "thread:c"],
      [ORPHAN_SLOT_BASE, "thread:b"],
    ]);
  });

  it("holds a slot whose move is unconfirmed: only resolve_move, kept when the budget is spent, done or deleting", () => {
    const failed = observe({
      workers: new Map([[0, seen({ runId: RunId.make("run:5"), runStatus: "failed" })]]),
      pendingMoves: pending,
    });
    const resolve = {
      type: "resolve_move",
      slot: 0,
      attempt: 1,
      actionId: moveId,
      clientRequestId: "goal:goal_mv:s0:a2:launch",
      stopRunId: "run:5",
      proceed: true,
    };
    expect(planGoal(goal, [onA], failed).actions).toEqual([resolve]);
    expect(planGoal(goal, [onA], { ...failed, turns: 2 }).actions).toEqual([resolve]);
    expect(
      planGoal({ ...goal, deletionRequestedAt: "2026-10-20T00:59:00.000Z" }, [onA], failed),
    ).toMatchObject({
      actions: [{ ...resolve, proceed: false }],
      status: { phase: "deleting" },
    });
    // Without the hold, a spent budget refuses the move itself.
    expect(planGoal(goal, [onA], { ...failed, pendingMoves: new Map(), turns: 2 }).actions).toEqual(
      [],
    );
  });

  it("calls off a move that never launched once the goal is done, still looking it up", () => {
    const issueGoal = testGoal("goal_mv", {
      spec: testSpec({
        targets: [{ type: "issue", number: 9 }],
        doneWhen: [{ type: "issues_closed" }],
      }),
    });
    const plan = planGoal(
      issueGoal,
      [onA],
      observe({
        workers: new Map([[0, seen({ runId: RunId.make("run:5"), runStatus: "failed" })]]),
        pendingMoves: pending,
        issues: new Map([[9, "closed"]]),
      }),
    );
    expect(plan.status.phase).toBe("succeeded");
    expect(plan.actions).toEqual([
      expect.objectContaining({ type: "resolve_move", actionId: moveId, proceed: false }),
    ]);
  });

  it("rebuilds a moved successor on its source's branch family after branchPrefix changed", () => {
    const renamed = {
      ...goal,
      spec: {
        ...goal.spec,
        workers: {
          ...goal.spec.workers,
          workspace: { ...goal.spec.workers.workspace, branchPrefix: "goal/renamed" },
        },
      },
    };
    const rebuilt = repairWorkers(renamed, [onA], [move("thread:b", "2026-10-20T00:00:03.000Z")]);
    expect(rebuilt[0]).toMatchObject({ attempt: 2, branch: "goal/test/s0-a2" });
  });

  it("follows the model a remote thread reports, and asks a person when a remote run is held at its usage limit", () => {
    const remote = running(goal, 0, { host: "B", followedUpRunId: RunId.make("run:5") });
    const plan = planGoal(
      goal,
      [remote],
      observe({
        workers: new Map([
          [
            0,
            seen({
              runId: RunId.make("run:5"),
              runStatus: "failed",
              health: { _tag: "failed", failureClass: "usage_limit", runId: RunId.make("run:5") },
              modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
            }),
          ],
        ]),
      }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.workers[0]).toMatchObject({
      state: "needs_human",
      modelSelection: { instanceId: "claude", model: "opus" },
    });
  });
});

describe("drain moves attempts idle between runs off a draining host (#1130)", () => {
  const goal = testGoal("goal_dr");
  const pair = testGoal("goal_dr", {
    spec: testSpec({ workers: { ...testSpec().workers, count: 2 } }),
  });
  const idle = () => seen({ runId: RunId.make("run:5"), health: { _tag: "healthy", idle: true } });
  const drainOf = (slot: number) => ({
    type: "drain",
    slot,
    attempt: 1,
    runId: "run:5",
    actionId: "goal:goal_dr:s" + slot + ":a1:run:5:reschedule",
  });
  const draining = (
    hosts: ReadonlyArray<string | null>,
    workers: ReadonlyArray<readonly [number, SlotObservation]>,
    extra: Partial<GoalObservation> = {},
  ) => observe({ drainingHosts: new Set(hosts), workers: new Map(workers), ...extra });
  const drains = (plan: ReturnType<typeof planGoal>) =>
    plan.actions.filter((action) => action.type === "drain");

  it("moves an idle attempt off an SSH host or this machine instead of following it up there", () => {
    const onA = running(goal, 0, { host: "A" });
    // Not draining: the finished run gets its follow-up where it is.
    expect(
      planGoal(goal, [onA], draining([], [[0, idle()]])).actions.map((action) => action.type),
    ).toEqual(["followup"]);
    const ssh = planGoal(goal, [onA], draining(["A"], [[0, idle()]]));
    expect(ssh.actions).toEqual([drainOf(0)]);
    expect(ssh.workers[0]).toMatchObject({
      state: "running",
      note: expect.stringMatching(/draining/),
    });
    const local = planGoal(goal, [running(goal, 0)], draining([null], [[0, idle()]]));
    expect(local.actions).toEqual([drainOf(0)]);
    // A thread with no run yet is left to start one: goal launches always carry the first run.
    expect(
      drains(
        planGoal(
          goal,
          [onA],
          draining(
            ["A"],
            [
              [
                0,
                seen({
                  runId: null,
                  terminal: false,
                  runStatus: null,
                  health: { _tag: "healthy", idle: true },
                }),
              ],
            ],
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("never moves a running attempt, queued work, a question, a stopped or failed run, or work on a cordon-only host", () => {
    const onA = running(goal, 0, { host: "A" });
    const cases: ReadonlyArray<readonly [string, SlotObservation]> = [
      [
        "running",
        seen({ terminal: false, runStatus: "running", health: { _tag: "healthy", idle: false } }),
      ],
      ["queued", seen({ health: { _tag: "waiting" } })],
      ["question", seen({ terminal: false, runStatus: "running", health: { _tag: "waiting" } })],
      [
        "stopped by a person",
        seen({ runStatus: "interrupted", health: { _tag: "healthy", idle: true } }),
      ],
    ];
    for (const [name, observed] of cases)
      expect(drains(planGoal(goal, [onA], draining(["A"], [[0, observed]]))), name).toEqual([]);
    // Cordoned but not draining: placement skips the host, its work stays.
    expect(drains(planGoal(goal, [onA], draining([], [[0, idle()]])))).toEqual([]);
    // A failed run on this machine still restarts here through ordinary recovery.
    const failed = planGoal(
      goal,
      [running(goal, 0)],
      draining(
        [null],
        [
          [
            0,
            seen({
              runId: RunId.make("run:5"),
              runStatus: "failed",
              health: { _tag: "failed", failureClass: "unknown", runId: RunId.make("run:5") },
            }),
          ],
        ],
      ),
    );
    expect(failed.actions).toEqual([
      expect.objectContaining({ type: "recover", reason: "failed", slot: 0 }),
    ]);
  });

  it("leaves an attempt that only waits for its pull request to merge: no next turn runs there", () => {
    const merging = testGoal("goal_dr", {
      spec: testSpec({ doneWhen: [{ type: "pull_requests_merged" }] }),
    });
    const waiting = running(merging, 0, {
      host: "A",
      pullRequest: { number: 7, state: "open", checks: "passing" },
    });
    const plan = planGoal(
      merging,
      [waiting],
      draining(["A"], [[0, idle()]], {
        pullRequests: new Map([[7, { kind: "seen", state: "open", checks: "passing" }]]),
      }),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.workers[0]).toMatchObject({
      state: "running",
      note: "Waiting for the pull request to merge.",
    });
    // Its checks fail: the fix would be a turn on the draining host, so it moves instead.
    const failing = planGoal(
      merging,
      [waiting],
      draining(["A"], [[0, idle()]], {
        pullRequests: new Map([[7, { kind: "seen", state: "open", checks: "failing" }]]),
      }),
    );
    expect(failing.actions).toEqual([drainOf(0)]);
  });

  it("moves one slot at a time: one drain per pass, none while any move of the goal is unsettled", () => {
    const workers = [running(pair, 0, { host: "A" }), running(pair, 1, { host: "A" })];
    const both = planGoal(
      pair,
      workers,
      draining(
        ["A"],
        [
          [0, idle()],
          [1, idle()],
        ],
      ),
    );
    expect(both.actions).toEqual([drainOf(0)]);
    expect(both.workers[1]).toMatchObject({
      state: "running",
      note: expect.stringMatching(/move/),
    });
    // Slot 1's earlier move is unconfirmed: it is only looked up, and slot 0 waits for it.
    const held = planGoal(
      pair,
      workers,
      draining(
        ["A"],
        [
          [0, idle()],
          [1, idle()],
        ],
        {
          pendingMoves: new Map([
            [
              1,
              {
                actionId: "goal:goal_dr:s1:a1:run:5:reschedule",
                attempt: 1,
                clientRequestId: "goal:goal_dr:s1:a2:launch",
                runId: RunId.make("run:5"),
              },
            ],
          ]),
        },
      ),
    );
    expect(held.actions.map((action) => action.type)).toEqual(["resolve_move"]);
    expect(held.workers[0]).toMatchObject({
      state: "running",
      note: expect.stringMatching(/move/),
    });
  });

  it("asks a person, without working on the draining host, when the attempt cannot move", () => {
    const last = running(goal, 0, { host: "A", attempt: 3 });
    const capped = planGoal(goal, [last], draining(["A"], [[0, idle()]]));
    expect(capped.actions).toEqual([]);
    expect(capped.workers[0]).toMatchObject({
      state: "needs_human",
      note: expect.stringMatching(/cannot move/),
    });
    const onA = running(goal, 0, { host: "A" });
    const refused = planGoal(
      goal,
      [onA],
      draining(["A"], [[0, idle()]], {
        refusedReschedules: new Set(["goal:goal_dr:s0:a1:run:5:reschedule"]),
      }),
    );
    expect(refused.actions).toEqual([]);
    expect(refused.workers[0]).toMatchObject({ state: "needs_human" });
    // Uncordoned: the worker carries on where it is.
    expect(
      planGoal(goal, [last], draining([], [[0, idle()]])).actions.map((action) => action.type),
    ).toEqual(["followup"]);
  });

  it("takes no drain when the budget is spent, the goal is paused, its owner lost authority, or it is being deleted", () => {
    const onA = [running(goal, 0, { host: "A" })];
    const ready = draining(["A"], [[0, idle()]]);
    expect(planGoal(goal, onA, { ...ready, turns: 40 }).actions).toEqual([]);
    expect(
      planGoal(testGoal("goal_dr", { spec: testSpec({ paused: true }) }), onA, ready).actions,
    ).toEqual([]);
    expect(
      planGoal(goal, onA, { ...ready, owner: { available: false, reason: "revoked" } }).actions,
    ).toEqual([]);
    expect(
      drains(planGoal({ ...goal, deletionRequestedAt: "2026-10-20T00:59:00.000Z" }, onA, ready)),
    ).toEqual([]);
  });
});
