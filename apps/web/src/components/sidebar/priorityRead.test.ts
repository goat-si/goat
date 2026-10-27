import { presentThreadShell } from "@goat/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Thread } from "../../types";
import { markSidebarPriorityRead, selectSidebarPriorityClear } from "./priorityRead";

const local = EnvironmentId.make("environment-local");
const readOnly = EnvironmentId.make("environment-read-only");
const visitedBefore = "2026-03-09T10:04:00.000Z";
const visitedAfter = "2026-03-09T10:06:00.000Z";
const completedRun: NonNullable<Thread["latestRun"]> = {
  runId: "turn-1" as never,
  status: "completed",
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

const thread = (id: string, overrides: ThreadFixtureOverrides = {}): Thread =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: local,
    runtime: null,
    latestRun: completedRun,
    notificationCompletedAt: completedRun.completedAt,
    lastVisitedAt: visitedAfter,
    ...overrides,
  });
const keyOf = (row: Thread) => scopedThreadKey(scopeThreadRef(row.environmentId, row.id));

function priorityRows() {
  const heldRead = thread("held-read");
  const unread = thread("unread", { lastVisitedAt: visitedBefore });
  const woke = thread("woke", {
    latestRun: null,
    notificationCompletedAt: null,
    lastVisitedAt: visitedBefore,
  });
  const acknowledgedWake = thread("acknowledged-wake", {
    latestRun: null,
    notificationCompletedAt: null,
    lastVisitedAt: visitedBefore,
  });
  const unreadElsewhere = thread("unread-read-only", {
    environmentId: readOnly,
    lastVisitedAt: visitedBefore,
  });
  const approval = thread("approval", { lastVisitedAt: visitedBefore, hasPendingApprovals: true });
  const input = thread("input", { hasPendingUserInput: true });
  const working = thread("working", {
    runtime: presentThreadShell(local, {
      ...makeThreadFixture().source,
      id: ThreadId.make("working"),
      latestRunId: RunId.make("run-working"),
      status: "running",
    }).runtime,
  });
  const childAttention = thread("child-attention", { lastVisitedAt: visitedBefore });
  return {
    heldRead,
    unread,
    woke,
    acknowledgedWake,
    unreadElsewhere,
    approval,
    input,
    working,
    childAttention,
  };
}

function planClear(rows: ReturnType<typeof priorityRows>) {
  return selectSidebarPriorityClear({
    threads: Object.values(rows),
    localLastVisitedAtByKey: {},
    // Priority ranks rows with effective wakes; settling acknowledged this one.
    wokeAtByKey: new Map([
      [keyOf(rows.woke), "2026-03-09T10:05:00.000Z"],
      [keyOf(rows.acknowledgedWake), null],
    ]),
    attentionByOwnerKey: new Map([[keyOf(rows.childAttention), true]]),
    canOperate: (row) => row.environmentId === local,
  });
}

describe("Clear read threads in Priority", () => {
  it("moves finished rows out and keeps work that still needs the user", () => {
    const rows = priorityRows();
    const plan = planClear(rows);

    expect(plan.markRead.map((row) => row.id)).toEqual([rows.unread.id, rows.woke.id]);
    expect(plan.releaseKeys).toEqual(
      [rows.heldRead, rows.unread, rows.woke, rows.acknowledgedWake].map(keyOf),
    );
  });

  it("returns a row to Priority when marking it read fails", async () => {
    const rows = priorityRows();
    const released = new Set<string>();
    const visited: string[] = [];

    await markSidebarPriorityRead({
      plan: planClear(rows),
      release: (keys) => keys.forEach((key) => released.add(key)),
      restore: (key) => released.delete(key),
      visit: async (row) => {
        visited.push(row.id);
        return row.id === rows.woke.id ? "failed" : "visited";
      },
    });

    expect(visited).toEqual([rows.unread.id, rows.woke.id]);
    expect([...released]).toEqual([rows.heldRead, rows.unread, rows.acknowledgedWake].map(keyOf));
  });
});
