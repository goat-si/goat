import { ScheduledTaskId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { botRoutineRows, type BotRoutineSource } from "./botRoutines.ts";

const now = Date.parse("2026-11-07T12:00:00.000Z");
const bot = ThreadId.make("bot-thread");
const routine = (id: string, fields: Partial<BotRoutineSource> = {}): BotRoutineSource => ({
  id: ScheduledTaskId.make(id),
  title: `Routine ${id}`,
  prompt: "Check the inbox",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  threadId: bot,
  nextRunAt: "2026-11-07T15:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  ...fields,
});

it("lists only the routines bound to the bot's thread", () => {
  const rows = botRoutineRows(
    [
      routine("a"),
      routine("b", { threadId: ThreadId.make("other") }),
      routine("c", { threadId: null }),
    ],
    bot,
    now,
  );
  expect(rows.map((row) => row.id)).toEqual(["a"]);
});

it("describes the schedule and the time until the next run", () => {
  const [row] = botRoutineRows([routine("a")], bot, now);
  expect(row).toMatchObject({
    scheduleText: "Weekdays at 09:00",
    nextText: "Next run in 3h",
    lastText: "Not run yet",
    lastFailed: false,
  });
});

it("says a paused routine is paused instead of naming a next run", () => {
  const [row] = botRoutineRows([routine("a", { enabled: false })], bot, now);
  expect(row?.nextText).toBe("Paused");
  expect(row?.enabled).toBe(false);
});

it("calls a run due once it is within the minute clock's precision", () => {
  const rows = botRoutineRows(
    [
      routine("past", { nextRunAt: "2026-11-07T11:59:00.000Z" }),
      routine("in-seconds", { nextRunAt: "2026-11-07T12:00:50.000Z" }),
      routine("in-two-minutes", { nextRunAt: "2026-11-07T12:02:00.000Z" }),
    ],
    bot,
    now,
  );
  expect(rows.map((row) => row.nextText)).toEqual([
    "Next run due",
    "Next run due",
    "Next run in 2m",
  ]);
});

it("shows when a failed run happened and the first line of its error", () => {
  const [row] = botRoutineRows(
    [
      routine("a", {
        lastRunAt: "2026-11-07T10:00:00.000Z",
        lastRunStatus: "failed",
        lastRunError: "Provider exited with code 1\nstack line",
      }),
    ],
    bot,
    now,
  );
  expect(row?.lastText).toBe("Last run 2h ago · failed: Provider exited with code 1");
  expect(row?.lastFailed).toBe(true);
});

it("orders enabled routines first, then by the soonest next run", () => {
  const rows = botRoutineRows(
    [
      routine("paused", { enabled: false, nextRunAt: "2026-11-07T12:30:00.000Z" }),
      routine("later", { nextRunAt: "2026-11-08T09:00:00.000Z" }),
      routine("unscheduled", { nextRunAt: null }),
      routine("soon", { nextRunAt: "2026-11-07T13:00:00.000Z" }),
    ],
    bot,
    now,
  );
  expect(rows.map((row) => row.id)).toEqual(["soon", "later", "unscheduled", "paused"]);
});
