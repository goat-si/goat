import { expect, it } from "vite-plus/test";
import { ChannelInputId, CommandId, ThreadId, type ScheduledTaskRecentRun } from "@goat/contracts";
import { scheduledTaskRunPresentation } from "../scheduledTaskRun.ts";
import {
  botRoutineRuns,
  routineRunFinished,
  routineRunState,
  routineRunTime,
} from "./routineRuns.ts";

const conversation = (input: string) => ({
  threadId: ThreadId.make("bot-thread"),
  inputId: ChannelInputId.make(input),
});
const run = (
  hour: number,
  status: string,
  extra: Partial<Pick<ScheduledTaskRecentRun, "conversation" | "quiet" | "dispatchFailed">> = {},
): ScheduledTaskRecentRun => ({
  firingId: CommandId.make(`firing-${hour}`),
  status,
  requestedAt: `2026-11-14T${String(hour).padStart(2, "0")}:00:00.000Z`,
  completedAt: null,
  ...extra,
});
const formatTime = (iso: string) => `Nov 14, ${iso.slice(11, 16)}`;

it("names each run's time and outcome in the last-run words, marks quiet runs, oldest first, at most the visible count", () => {
  const recentRuns = [
    run(9, "completed", { quiet: true, conversation: conversation("input-9") }),
    run(8, "failed", { conversation: conversation("input-8") }),
    run(7, "failed", { dispatchFailed: true }),
    // The bot took this run, but its conversation is unknown: it still only failed.
    run(6, "failed"),
    run(5, "running", { conversation: conversation("input-5") }),
    run(4, "paused_by_policy"),
    run(3, "completed", { conversation: conversation("input-3") }),
  ];
  const dots = botRoutineRuns({ recentRuns }, 6, formatTime);
  expect(dots.map((dot) => [dot.shape, dot.accessibleName, dot.conversation?.inputId])).toEqual([
    ["hollow-square", "Run on Nov 14, 04:00, outcome unavailable", undefined],
    ["hollow-diamond", "Run on Nov 14, 05:00, running", "input-5"],
    ["filled-square", "Run on Nov 14, 06:00, failed", undefined],
    ["filled-square", "Run on Nov 14, 07:00, dispatch failed", undefined],
    ["filled-square", "Run on Nov 14, 08:00, failed", "input-8"],
    ["bar", "Run on Nov 14, 09:00, no update", "input-9"],
  ]);
  // A failed run reads as the row's last-run line reads it, from the same dispatch outcome.
  const lastRunWord = (dispatchStatus: "accepted" | "failed") =>
    scheduledTaskRunPresentation({
      lastRunStatus: "failed",
      lastRun: {
        firingId: CommandId.make("firing"),
        dispatchStatus,
        status: "failed",
        threadId: null,
        runId: null,
        requestedAt: recentRuns[0]!.requestedAt,
        dispatchedAt: null,
        startedAt: null,
        completedAt: null,
      },
    }).label.toLowerCase();
  expect([dots[2]?.word, dots[3]?.word]).toEqual([lastRunWord("accepted"), lastRunWord("failed")]);
});

it("absent history draws no dots", () => {
  expect(botRoutineRuns({}, 7, formatTime)).toEqual([]);
  expect(botRoutineRuns({ recentRuns: [] }, 7, formatTime)).toEqual([]);
});

it("carries each run's raw status, quiet and dispatch failure, so a client never reads the display word", () => {
  const recentRuns = [
    run(9, "completed", { quiet: true, conversation: conversation("input-9") }),
    run(8, "failed", { dispatchFailed: true }),
    run(7, "running", { conversation: conversation("input-7") }),
  ];
  const dots = botRoutineRuns({ recentRuns }, 7, formatTime);
  expect(dots.map((dot) => [dot.status, dot.quiet, dot.dispatchFailed])).toEqual([
    ["running", undefined, undefined],
    ["failed", undefined, true],
    ["completed", true, undefined],
  ]);
});

it("a run is in flight, ended, or unsettled: an unknown status counts as ended only once it has a finish time", () => {
  const state = (status: string, completedAt: string | null = null) =>
    routineRunState({ status, completedAt });
  expect(["dispatching", "queued", "running"].map((status) => state(status))).toEqual([
    "in-flight",
    "in-flight",
    "in-flight",
  ]);
  expect(
    ["completed", "failed", "interrupted", "cancelled", "rolled_back"].map((status) =>
      state(status),
    ),
  ).toEqual(["ended", "ended", "ended", "ended", "ended"]);
  expect(state("paused_by_policy")).toBe("unsettled");
  expect(state("paused_by_policy", "2026-11-14T09:05:00.000Z")).toBe("ended");
});

it("formats a run's time as short month, day, hour and minute, in the given locale and hour choice", () => {
  const at = "2026-11-14T09:00:00.000Z";
  expect(routineRunTime(at, { locale: "en-US", hour12: true, timeZone: "UTC" })).toBe(
    "Nov 14, 9:00 AM",
  );
  expect(routineRunTime(at, { locale: "en-US", hour12: false, timeZone: "UTC" })).toBe(
    "Nov 14, 09:00",
  );
  // Without a choice, the locale's own hour form applies.
  expect(routineRunTime(at, { locale: "en-GB", timeZone: "UTC" })).toBe("14 Nov, 09:00");
});

it("joins the date and time with a comma on every engine, and can give the time alone", () => {
  const at = "2026-11-14T21:05:00.000Z";
  expect(routineRunTime(at, { locale: "en-US", hour12: true, timeZone: "UTC" })).toBe(
    "Nov 14, 9:05 PM",
  );
  expect(
    routineRunTime(at, { locale: "en-US", hour12: false, timeZone: "UTC", timeOnly: true }),
  ).toBe("21:05");
});

it("a time that cannot be read gives 'Unknown time' and does not throw", () => {
  expect(routineRunTime("not a time", { locale: "en-US", timeZone: "UTC" })).toBe("Unknown time");
  expect(routineRunTime("", { timeOnly: true })).toBe("Unknown time");
  const [dot] = botRoutineRuns(
    { recentRuns: [{ ...run(9, "completed"), requestedAt: "garbled", completedAt: "garbled" }] },
    7,
    routineRunTime,
  );
  expect(dot?.accessibleName).toBe("Run on Unknown time, completed");
  expect(routineRunState({ status: "mystery", completedAt: "garbled" })).toBe("ended");
});

it("says when a run finished: the time alone on the day it started, in the formatter's zone, else date and time", () => {
  const options = { locale: "en-US", hour12: true, timeZone: "UTC" } as const;
  expect(routineRunFinished("2026-11-14T09:00:00.000Z", null, options)).toBeNull();
  expect(routineRunFinished("2026-11-14T09:00:00.000Z", "2026-11-14T09:04:00.000Z", options)).toBe(
    "finished 9:04 AM",
  );
  expect(routineRunFinished("2026-11-14T09:00:00.000Z", "2026-11-17T09:00:00.000Z", options)).toBe(
    "finished Nov 17, 9:00 AM",
  );
  // 23:30 to 00:30 UTC is one day in Seoul and two in UTC: the day follows the given zone.
  const lateStart = "2026-11-14T23:30:00.000Z";
  const earlyFinish = "2026-11-15T00:30:00.000Z";
  expect(routineRunFinished(lateStart, earlyFinish, options)).toBe("finished Nov 15, 12:30 AM");
  expect(routineRunFinished(lateStart, earlyFinish, { ...options, timeZone: "Asia/Seoul" })).toBe(
    "finished 9:30 AM",
  );
});

it("a finish time that cannot be read says Unknown time, and an unreadable start gives the full finish, without throwing", () => {
  const options = { locale: "en-US", hour12: true, timeZone: "UTC" } as const;
  expect(routineRunFinished("garbled", "garbled", options)).toBe("finished Unknown time");
  expect(routineRunFinished("2026-11-14T09:00:00.000Z", "garbled", options)).toBe(
    "finished Unknown time",
  );
  expect(routineRunFinished("garbled", "2026-11-14T09:04:00.000Z", options)).toBe(
    "finished Nov 14, 9:04 AM",
  );
});

const at = "2026-11-14T09:00:00.000Z";
const enUSShort = /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/;
// Kathmandu is UTC+5:45; on a device set to UTC, a dropped zone reads 09:00 instead of 14:45.
const kathmandu = "Asia/Kathmandu";
const onUtcDevice = (check: () => void) => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    check();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};
// The 24-hour time in `timeZone` as the device's own locale writes it, in its own digits.
const deviceClock = (timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(Date.parse(at));

it("an invalid locale falls back to the device locale and keeps a valid zone, without throwing", () => {
  onUtcDevice(() => {
    const options = { locale: "not a locale!", timeZone: kathmandu, hour12: false } as const;
    const time = routineRunTime(at, options);
    expect(time.endsWith(deviceClock(kathmandu))).toBe(true);
    expect(time.endsWith(deviceClock("UTC"))).toBe(false);
    expect(routineRunTime(at, options)).toBe(time);
  });
});

it("an invalid zone falls back to the device zone and keeps a valid locale, without throwing", () => {
  const time = routineRunTime(at, { locale: "en-US", timeZone: "Not/A_Zone", hour12: false });
  expect(time).toMatch(enUSShort);
  expect(routineRunTime(at, { locale: "en-US", timeZone: "Not/A_Zone", hour12: false })).toBe(time);
});

it("a null or Symbol locale reads in the device locale, without throwing", () => {
  onUtcDevice(() => {
    for (const locale of [null, Symbol("locale")]) {
      const time = routineRunTime(at, {
        locale: locale as never,
        timeZone: kathmandu,
        hour12: false,
      });
      expect(time.endsWith(deviceClock(kathmandu))).toBe(true);
      expect(time.endsWith(deviceClock("UTC"))).toBe(false);
      expect(routineRunFinished(at, at, { locale: locale as never, timeZone: kathmandu })).toMatch(
        /^finished /,
      );
    }
  });
});

it("a time that is not a string gives 'Unknown time', and a start that is not one is not the finish's day", () => {
  const options = { locale: "en-US", hour12: false, timeZone: "UTC" } as const;
  expect(routineRunTime(Symbol("time") as never, options)).toBe("Unknown time");
  // A number would parse as a year; it is not a stored time.
  expect(routineRunTime(2026 as never, options)).toBe("Unknown time");
  expect(routineRunFinished(Symbol("start") as never, at, options)).toBe("finished Nov 14, 09:00");
  expect(routineRunFinished(at, Symbol("finish") as never, options)).toBe("finished Unknown time");
});

it("a run with no finish time has no finish line, whether it is null or left out", () => {
  expect(
    routineRunFinished(at, undefined as never, { locale: "en-US", timeZone: "UTC" }),
  ).toBeNull();
});

it("a device zone change while the app is open reads the next time in the new zone", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    // @effect-diagnostics-next-line globalDate:off -- the zone's offset at the fixed test instant.
    const tokyo = new Date(at).getTimezoneOffset();
    expect(routineRunTime(at, { locale: "en-US", hour12: false })).toBe("Nov 14, 18:00");
    process.env.TZ = "America/New_York";
    // The guard: Node read the new zone, so a stale formatter is what the next line would catch.
    // @effect-diagnostics-next-line globalDate:off -- the zone's offset at the fixed test instant.
    expect(new Date(at).getTimezoneOffset()).not.toBe(tokyo);
    expect(routineRunTime(at, { locale: "en-US", hour12: false })).toBe("Nov 14, 04:00");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

it("a zone that falls back to the device's follows a device zone change too", () => {
  const before = process.env.TZ;
  const options = { locale: "en-US", hour12: false, timeZone: "Not/A_Zone" } as const;
  try {
    process.env.TZ = "Asia/Tokyo";
    expect(routineRunTime(at, options)).toBe("Nov 14, 18:00");
    process.env.TZ = "America/New_York";
    expect(routineRunTime(at, options)).toBe("Nov 14, 04:00");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
