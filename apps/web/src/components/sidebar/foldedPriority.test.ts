import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { presentThreadShell } from "@goat/client-runtime/state/models";
import { EnvironmentId, RunId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Thread } from "../../types";
import { countVisibleSidebarPriorityThreads, resolveSidebarPriorityRank } from "../Sidebar.logic";
import { foldedPriorityMember, wakesBeforeFold, withFoldedUnseen } from "./foldedPriority";
import { foldLaunchedThreads, foldedUnseenUnder, liftedPriorityRank } from "./launchFold";
import { markSidebarPriorityRead, selectSidebarPriorityClear } from "./priorityRead";

const local = EnvironmentId.make("environment-local");
const readOnly = EnvironmentId.make("environment-read-only");
const NOW = "2026-03-09T12:00:00.000Z";
const before = "2026-03-09T10:04:00.000Z";
const after = "2026-03-09T10:06:00.000Z";
const completedRun: NonNullable<Thread["latestRun"]> = {
  runId: "turn-1" as never,
  status: "completed",
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

function row(
  id: string,
  overrides: ThreadFixtureOverrides & {
    readonly launchedBy?: string;
    readonly launcherEnvironment?: EnvironmentId;
  } = {},
): Thread {
  const { launchedBy, launcherEnvironment, ...rest } = overrides;
  const base = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: local,
    runtime: null,
    latestRun: completedRun,
    notificationCompletedAt: completedRun.completedAt,
    lastVisitedAt: after,
    ...rest,
  });
  if (launchedBy === undefined) return base;
  return {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make(launchedBy),
        environmentId: launcherEnvironment ?? null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch",
      },
    },
  };
}
const keyOf = (thread: Thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const working = (id: string) =>
  presentThreadShell(local, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    latestRunId: RunId.make(`run-${id}`),
    status: "running",
  }).runtime;
const capabilitiesOf = () => ({ threadSnooze: true, threadSettlement: true });

function fold(
  threads: readonly Thread[],
  options: {
    readonly local?: Readonly<Record<string, string | undefined>>;
    readonly wakes?: ReadonlyMap<string, string | null>;
  } = {},
) {
  return foldLaunchedThreads({
    visible: threads,
    all: threads,
    now: NOW,
    unseen: foldedPriorityMember({
      now: NOW,
      localLastVisitedAtByKey: options.local ?? {},
      capabilitiesOf,
      ...(options.wakes === undefined ? {} : { wakes: options.wakes }),
    }),
  });
}
const rankOf = (result: ReturnType<typeof fold>, launcher: Thread) =>
  liftedPriorityRank(null, result.liftByKey.get(keyOf(launcher)));

describe("unread threads folded under a launcher", () => {
  it("lift a read launcher into Priority while their dot stays finished", () => {
    const launcher = row("launcher");
    const child = row("child", { launchedBy: "launcher", lastVisitedAt: before });
    const result = fold([launcher, child]);
    expect(result.folded.map((thread) => thread.id)).toEqual(["child"]);
    expect(rankOf(result, launcher)).toBe(2);
    expect(result.stateByKey.get(keyOf(child))).toBe("finished");
    expect(rankOf(fold([launcher, { ...child, lastVisitedAt: after }]), launcher)).toBeNull();
  });

  it("follow the server's visit over a stale local one", () => {
    const launcher = row("launcher");
    const child = row("child", { launchedBy: "launcher", lastVisitedAt: before });
    expect(rankOf(fold([launcher, child], { local: { [keyOf(child)]: after } }), launcher)).toBe(2);
  });

  it("lift for an unseen wake, but not for one a settle acknowledged", () => {
    const launcher = row("launcher");
    const woke = row("woke", {
      launchedBy: "launcher",
      latestRun: null,
      notificationCompletedAt: null,
      lastVisitedAt: before,
      snoozedUntil: "2026-03-09T11:00:00.000Z",
    });
    expect(rankOf(fold([launcher, woke]), launcher)).toBe(2);

    // Settled while Priority held it as active: the settle acknowledges the wake this render,
    // even though the thread folds in the same render.
    const settled = { ...woke, settledOverride: "settled" as const };
    const acknowledged = new Set<string>();
    const wakes = wakesBeforeFold({
      threads: [launcher, settled],
      now: NOW,
      holds: new Map([[keyOf(settled), null]]),
      acknowledged,
      skipKey: null,
    });
    expect(acknowledged.has(keyOf(settled))).toBe(true);
    expect(rankOf(fold([launcher, settled], { wakes }), launcher)).toBeNull();

    // Unsettled again, the acknowledgement ends and the wake lifts again.
    const reopened = wakesBeforeFold({
      threads: [launcher, woke],
      now: NOW,
      holds: new Map(),
      acknowledged,
      skipKey: null,
    });
    expect(acknowledged.has(keyOf(woke))).toBe(false);
    expect(rankOf(fold([launcher, woke], { wakes: reopened }), launcher)).toBe(2);
  });

  it("keep their own row under a settled launcher, and are found two levels down", () => {
    const settledLauncher = row("settled", { settledOverride: "settled" });
    const unread = row("unread", { launchedBy: "settled", lastVisitedAt: before });
    expect(fold([settledLauncher, unread]).roots.map((thread) => thread.id)).toEqual([
      "settled",
      "unread",
    ]);

    const launcher = row("launcher");
    const middle = row("middle", { launchedBy: "launcher" });
    const leaf = row("leaf", { launchedBy: "middle", lastVisitedAt: before });
    const result = fold([launcher, middle, leaf]);
    expect(foldedUnseenUnder(result, keyOf(launcher)).map((thread) => thread.id)).toEqual(["leaf"]);
    expect(rankOf(result, launcher)).toBe(2);
  });

  it("count once on the activity bell through their launcher", () => {
    const launcher = row("launcher");
    const child = row("child", { launchedBy: "launcher", lastVisitedAt: before });
    const result = fold([launcher, child]);
    const count = (childUnseenKeys: ReadonlySet<string>) =>
      countVisibleSidebarPriorityThreads({
        threads: result.roots,
        now: NOW,
        localLastVisitedAtByKey: {},
        attentionByOwnerKey: new Map(),
        childUnseenKeys,
        supportsSnooze: () => true,
        supportsSettlement: () => true,
      });
    const unseen = new Set(
      [...result.liftByKey].flatMap(([key, lift]) => (lift === "unseen" ? [key] : [])),
    );
    expect(count(unseen)).toBe(1);
    expect(count(new Set())).toBe(0);
  });
});

describe("reading Priority with unread threads folded under its rows", () => {
  const launcher = row("launcher");
  const child = row("child", { launchedBy: "launcher", lastVisitedAt: before });
  const busy = row("busy", { runtime: working("busy") });
  const busyChild = row("busy-child", { launchedBy: "busy", lastVisitedAt: before });
  const elsewhere = row("elsewhere", { environmentId: readOnly, lastVisitedAt: before });
  const elsewhereChild = row("elsewhere-child", {
    launchedBy: "elsewhere",
    launcherEnvironment: readOnly,
    lastVisitedAt: before,
  });
  const hidden = row("hidden-child", {
    environmentId: readOnly,
    launchedBy: "launcher",
    launcherEnvironment: local,
    lastVisitedAt: before,
  });
  const threads = [launcher, child, hidden, busy, busyChild, elsewhere, elsewhereChild];
  const result = fold(threads);
  const rows = result.roots;
  const canOperate = (thread: Thread) => thread.environmentId === local;
  const liftedOnly = (thread: Thread) =>
    resolveSidebarPriorityRank({
      thread,
      localLastVisitedAt: undefined,
      wokeAt: null,
      hasChildAttention: false,
    }) === null;
  const clear = () =>
    withFoldedUnseen(
      selectSidebarPriorityClear({
        threads: rows,
        localLastVisitedAtByKey: {},
        wokeAtByKey: new Map(),
        attentionByOwnerKey: new Map(),
        canOperate,
      }),
      { rows, unseenUnder: (key) => foldedUnseenUnder(result, key), canOperate, liftedOnly },
    );

  it("visits operable unread children and releases only rows held by them", () => {
    expect(rows.map((thread) => thread.id)).toEqual(["launcher", "busy", "elsewhere"]);
    const plan = clear();
    expect(plan.markRead.map((thread) => thread.id)).toEqual([
      "child",
      "busy-child",
      "elsewhere-child",
    ]);
    // The busy row stays for its own work and the read-only row for its own unread; the
    // launcher was there only for its children, so it leaves.
    expect(plan.releaseKeys).toEqual([keyOf(launcher)]);
  });

  it("returns the launcher when visiting one of its children fails", async () => {
    const released = new Set<string>();
    await markSidebarPriorityRead({
      plan: clear(),
      release: (keys) => keys.forEach((key) => released.add(key)),
      restore: (key) => released.delete(key),
      visit: async (thread) => (thread.id === "child" ? "failed" : "visited"),
    });
    expect([...released]).toEqual([]);
  });
});
