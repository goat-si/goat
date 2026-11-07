import { EnvironmentId, RunId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "./threadListV2";

it("ages a read row from its latest reply", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const now = Date.parse("2026-06-02T00:00:00.000Z");
  vi.useFakeTimers({ now });
  const earlier = new Date(now - 40 * 60_000).toISOString();
  const completedAt = new Date(now - 2 * 60_000).toISOString();
  const thread = makeThreadShellFixture({
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("stamp-read"),
    title: "stamp read",
    latestUserMessageAt: earlier,
    lastVisitedAt: new Date(now).toISOString(),
    latestRun: {
      runId: RunId.make("stamp-read-run"),
      status: "completed",
      requestedAt: earlier,
      startedAt: earlier,
      completedAt,
      assistantMessageId: null,
    },
  });
  const layout = buildThreadListV2Items({
    threads: [thread],
    environmentId: null,
    searchQuery: "",
    now: new Date(now).toISOString(),
    snoozedShelfExpanded: true,
  });
  const rows = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks: [],
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: true,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: new Date(now).toISOString(),
  });
  const row = rows[0];
  expect(row?.type === "v2-thread" ? row.timeLabel : null).toBe("2m");
});
