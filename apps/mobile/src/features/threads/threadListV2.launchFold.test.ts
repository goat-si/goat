import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { threadArrangementSections } from "./threadArrangementSections";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  resolveThreadListV2Status,
} from "./threadListV2";
import {
  liftedThreadListV2Status,
  projectLaunchSubagentRows,
  threadListV2ReorderExcludedKeys,
  type ThreadListV2LaunchGroupState,
} from "./threadListV2LaunchFold";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";
const key = (id: string) => `${environmentId}:${id}`;
const environments = new Set([environmentId]);

function shell(
  id: string,
  options: {
    readonly launchedBy?: string;
    readonly createdAt?: string;
    readonly running?: boolean;
    readonly approval?: boolean;
    readonly settled?: boolean;
    readonly snoozedUntil?: string;
    readonly pinned?: boolean;
    readonly unread?: boolean;
    readonly subagentOf?: string;
  } = {},
): EnvironmentThreadShell {
  const base = makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id });
  return {
    ...base,
    createdAt: options.createdAt ?? "2026-06-01T00:00:00.000Z",
    hasPendingApprovals: options.approval ?? false,
    settledOverride: options.settled ? "settled" : null,
    snoozedUntil: options.snoozedUntil ?? null,
    snoozedAt: options.snoozedUntil ? "2026-06-01T00:00:00.000Z" : null,
    pinnedAt: options.pinned ? "2026-06-01T00:00:00.000Z" : null,
    lineage: {
      rootThreadId: ThreadId.make(options.subagentOf ?? id),
      parentThreadId: options.subagentOf ? ThreadId.make(options.subagentOf) : null,
      relationshipToParent: options.subagentOf ? "subagent" : null,
    },
    runtime: options.running
      ? {
          status: "running",
          activeRunId: RunId.make(`run-${id}`),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: NOW,
        }
      : base.runtime,
    ...(options.unread
      ? {
          lastVisitedAt: "2026-06-01T09:00:00.000Z",
          latestRun: {
            runId: RunId.make(`run-${id}`),
            status: "completed",
            requestedAt: "2026-06-01T09:30:00.000Z",
            startedAt: "2026-06-01T09:30:00.000Z",
            completedAt: "2026-06-01T10:00:00.000Z",
            assistantMessageId: null,
          },
        }
      : {}),
    source: {
      ...base.source,
      ...(options.launchedBy === undefined
        ? {}
        : {
            launchedBy: {
              kind: "launch",
              threadId: ThreadId.make(options.launchedBy),
              environmentId: null,
              environmentLabel: null,
              threadTitle: null,
              via: "thread_launch",
            },
          }),
    },
  };
}

const COLLAPSED: ThreadListV2LaunchGroupState = {
  expanded: {},
  showAll: new Set(),
  routeCollapsed: new Set(),
};
const expandedFor = (...ids: string[]): ThreadListV2LaunchGroupState => ({
  ...COLLAPSED,
  expanded: Object.fromEntries(ids.map((id) => [key(id), true])),
});

function layoutOf(
  threads: readonly EnvironmentThreadShell[],
  options: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {},
) {
  return buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
    settlementEnvironmentIds: environments,
    snoozeEnvironmentIds: environments,
    launchGroups: COLLAPSED,
    ...options,
  });
}

const rows = (layout: ReturnType<typeof layoutOf>) =>
  layout.items.map((item) => `${"  ".repeat(item.depth ?? 0)}${item.thread.id}`);

describe("mobile thread list launch folds", () => {
  it("folds launched threads under their launcher behind one collapsed line", () => {
    const layout = layoutOf([
      shell("launcher"),
      shell("done", { launchedBy: "launcher" }),
      shell("busy", { launchedBy: "launcher", running: true }),
      shell("other"),
    ]);
    expect(rows(layout).toSorted()).toEqual(["launcher", "other"]);
    const list = buildThreadListV2ListItems({
      items: layout.items,
      launchMarkers: layout.launchMarkers,
      pendingTasks: [],
    });
    const launcherIndex = list.findIndex((item) => item.key === `v2-thread:${key("launcher")}`);
    expect(list[launcherIndex + 1]).toMatchObject({
      type: "v2-launch-group",
      parentKey: key("launcher"),
      label: "2 threads · 1 running",
      states: ["working", "finished"],
      expanded: false,
    });
  });

  it("lists children people first, then running work, newest launch first, one level deeper", () => {
    const layout = layoutOf(
      [
        shell("launcher"),
        shell("old", { launchedBy: "launcher", createdAt: "2026-06-01T01:00:00.000Z" }),
        shell("new", { launchedBy: "launcher", createdAt: "2026-06-01T02:00:00.000Z" }),
        shell("busy", { launchedBy: "launcher", running: true }),
        shell("asks", { launchedBy: "launcher", approval: true }),
      ],
      { launchGroups: expandedFor("launcher") },
    );
    expect(rows(layout)).toEqual(["launcher", "  asks", "  busy", "  new", "  old"]);
  });

  it("folds work a subagent launched under the row that owns the subagent", () => {
    const layout = layoutOf([shell("owner"), shell("lane", { launchedBy: "helper" })], {
      launchOwners: [shell("helper", { subagentOf: "owner" })],
    });
    expect(rows(layout)).toEqual(["owner"]);
    expect(layout.launchMarkers?.map((marker) => marker.entry.parentKey)).toEqual([key("owner")]);
  });

  it("lifts a settled launcher with running work to the top of the list, out of the settled shelf", () => {
    const layout = layoutOf(
      [
        shell("active"),
        shell("launcher", { settled: true }),
        shell("busy", { launchedBy: "launcher", running: true, settled: true }),
      ],
      { workingShelfEnabled: true, workingShelfExpanded: false },
    );
    expect(rows(layout)).toEqual(["launcher", "active"]);
    expect(layout.items[0]).toMatchObject({ variant: "card", lift: "working" });
    expect(layout.settledCount).toBe(0);
    expect(layout.workingCount).toBe(0);
  });

  it("shows a request waiting under a launcher as its own, and keeps it out of the working shelf", () => {
    const layout = layoutOf(
      [
        shell("launcher", { running: true }),
        shell("asks", { launchedBy: "launcher", approval: true }),
      ],
      { workingShelfEnabled: true, workingShelfExpanded: false },
    );
    expect(rows(layout)).toEqual(["launcher"]);
    expect(layout.workingCount).toBe(0);
    const item = layout.items[0];
    expect(item?.lift).toBe("approval");
    expect(liftedThreadListV2Status(resolveThreadListV2Status(item!.thread), item?.lift)).toBe(
      "approval",
    );
  });

  it("marks a launcher unread for unread work folded under it, settled work included", () => {
    const active = layoutOf([
      shell("launcher"),
      shell("finished", { launchedBy: "launcher", unread: true }),
    ]);
    expect(active.items[0]?.lift).toBe("unseen");
    const settled = layoutOf([
      shell("launcher", { settled: true }),
      shell("finished", { launchedBy: "launcher", unread: true, settled: true }),
    ]);
    expect(rows(settled)).toEqual(["launcher"]);
    expect(settled.items[0]).toMatchObject({ variant: "card", lift: "unseen" });
    expect(settled.settledCount).toBe(0);
  });

  it("keeps a queued settled thread on its own row instead of folding it into a settled launcher", () => {
    const layout = layoutOf(
      [
        shell("launcher", { settled: true }),
        shell("queued", { launchedBy: "launcher", settled: true }),
      ],
      { queuedThreadKeys: new Set([key("queued")]) },
    );
    expect(rows(layout).toSorted()).toEqual(["launcher", "queued"]);
    expect(layout.items.find((item) => item.thread.id === "queued")?.variant).toBe("card");
  });

  it("keeps live work out of a snoozed launcher and wakes for a folded snoozed thread", () => {
    const snoozedLauncher = layoutOf([
      shell("launcher", { snoozedUntil: "2026-06-03T00:00:00.000Z" }),
      shell("busy", { launchedBy: "launcher", running: true }),
    ]);
    expect(rows(snoozedLauncher)).toEqual(["busy"]);
    expect(snoozedLauncher.snoozedCount).toBe(1);
    expect(snoozedLauncher.launchMarkers).toEqual([]);
    const folded = layoutOf([
      shell("launcher"),
      shell("later", { launchedBy: "launcher", snoozedUntil: "2026-06-02T06:00:00.000Z" }),
    ]);
    expect(rows(folded)).toEqual(["launcher"]);
    expect(folded.nextSnoozeWakeAt).toBe("2026-06-02T06:00:00.000Z");
  });

  it("lists five children, then +N more, and the selected child past the limit", () => {
    const threads = [
      shell("launcher"),
      ...Array.from({ length: 7 }, (_, index) =>
        shell(`child-${index}`, {
          launchedBy: "launcher",
          createdAt: `2026-06-01T0${index}:00:00.000Z`,
        }),
      ),
    ];
    const limited = layoutOf(threads, { launchGroups: expandedFor("launcher") });
    expect(rows(limited)).toEqual([
      "launcher",
      "  child-6",
      "  child-5",
      "  child-4",
      "  child-3",
      "  child-2",
    ]);
    expect(limited.launchMarkers?.at(-1)).toEqual({
      afterIndex: 5,
      entry: { kind: "launch-more", parentKey: key("launcher"), depth: 0, hidden: 2 },
    });
    const all = layoutOf(threads, {
      launchGroups: { ...expandedFor("launcher"), showAll: new Set([key("launcher")]) },
    });
    expect(all.items).toHaveLength(8);
    const selected = layoutOf(threads, { selectedThreadKey: key("child-0") });
    expect(rows(selected).at(-1)).toBe("  child-0");
    expect(selected.launchRevealKeys).toEqual([key("launcher")]);
    const collapsedWhileSelected = layoutOf(threads, {
      selectedThreadKey: key("child-0"),
      launchGroups: { ...COLLAPSED, routeCollapsed: new Set([key("launcher")]) },
    });
    expect(rows(collapsedWhileSelected)).toEqual(["launcher"]);
    expect(collapsedWhileSelected.launchRevealKeys).toEqual([]);
  });

  it("keeps a collapsed shelf showing the row that holds the selected folded thread", () => {
    const layout = layoutOf(
      [
        shell("launcher", { settled: true }),
        shell("done", { launchedBy: "launcher", settled: true }),
        shell("other", { settled: true }),
      ],
      { settledShelfExpanded: false, selectedThreadKey: key("done") },
    );
    expect(rows(layout)).toEqual(["launcher", "  done"]);
  });

  it("lists every match flat while searching", () => {
    const layout = layoutOf(
      [shell("launcher"), shell("launched work", { launchedBy: "launcher" })],
      { searchQuery: "launch" },
    );
    expect(rows(layout).toSorted()).toEqual(["launched work", "launcher"]);
    expect(layout.launchMarkers).toBeUndefined();
  });

  it("leaves folded and lifted rows out of reordering and the arrangement sheet", () => {
    const threads = [
      shell("plain"),
      shell("launcher", { settled: true }),
      shell("busy", { launchedBy: "launcher", running: true }),
    ];
    const placement = {
      threads,
      now: NOW,
      settlementEnvironmentIds: environments,
      snoozeEnvironmentIds: environments,
    };
    expect([...threadListV2ReorderExcludedKeys(placement)].toSorted()).toEqual([
      key("busy"),
      key("launcher"),
    ]);
    const sections = threadArrangementSections({
      ...placement,
      queuedThreadKeys: new Set(),
      pendingOrder: null,
      hiddenBotThreadKeys: new Set(),
      workingShelfEnabled: false,
      launchOwners: [],
    });
    expect(sections.active.map((thread) => String(thread.id))).toEqual(["plain"]);
    expect(sections.settled).toEqual([]);
  });

  it("keeps the subagent rows a list reads while a streaming turn rewrites their shells", () => {
    const owner = shell("owner");
    const helper = shell("helper", { subagentOf: "owner" });
    const first = projectLaunchSubagentRows([], [owner, helper]);
    expect(
      projectLaunchSubagentRows(first, [
        { ...owner, title: "new" },
        { ...helper, title: "x" },
      ]),
    ).toBe(first);
    const moved = projectLaunchSubagentRows(first, [
      owner,
      shell("helper", { subagentOf: "other" }),
    ]);
    expect(moved).not.toBe(first);
  });
});
