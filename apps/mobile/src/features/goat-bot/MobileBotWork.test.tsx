import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import {
  container,
  nativePlatform,
  press,
  render,
  renderWork,
  reset,
  state,
  WorkWithChip,
} from "./mobileBotWorkTestHarness";
import { BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import React, { act } from "react";
import { expect, it } from "vite-plus/test";
import { GoatBotChipFace } from "./GoatBotFace";

it("distinguishes task and routine loading, empty, offline, and retry states", async () => {
  reset();
  await render();
  await press("Work");
  expect(container.querySelector('[aria-label="Loading tasks…"]')).not.toBeNull();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render();
  expect(container.textContent).toContain("No recent tasks");
  Object.assign(state.task, { error: "failed", isSuccess: false });
  await render();
  // The last read was empty, but a failed read says nothing about whether tasks exist now.
  expect(container.textContent).not.toContain("No recent tasks");
  expect(container.textContent).toContain("Couldn't load GOAT Bot's tasks.");
  await press("Try again");
  expect(state.task.refresh).toHaveBeenCalledOnce();
  // Routines sit on Home with machines and work.
  expect(container.textContent).toContain("Loading routines");
  Object.assign(state.routines, { isPending: false, isSuccess: true, data: { tasks: [] } });
  await render();
  expect(container.textContent).toContain("set up a routine");
  Object.assign(state.routines, { error: "failed", isSuccess: false });
  await render();
  await press("Couldn't load routines");
  expect(state.routines.refresh).toHaveBeenCalledOnce();
  state.connected = false;
  await render();
  expect(container.textContent).toContain("offline");
});

it("lists the tasks the chat shows while the work list loads or after it failed", async () => {
  reset();
  const card: GoatBotTaskCard = {
    key: "chat-task",
    revision: 1,
    updatedAt: "2026-11-07T10:00:00.000Z",
    title: "Task from the chat",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "Task from the chat" },
  };
  await render(undefined, undefined, [], [card]);
  await press("Work");
  expect(container.querySelector('[aria-label="Loading tasks…"]')).not.toBeNull();
  expect(container.textContent).toContain("Earlier in chat");
  Object.assign(state.task, { isPending: false, error: "failed" });
  await render(undefined, undefined, [], [card]);
  expect(container.textContent).toContain("Couldn't load GOAT Bot's tasks.");
  expect(container.textContent).toContain("Earlier in chat");
});

it("checks the chat fallback task and fetches the second Snoozed page from Home", async () => {
  reset();
  state.snoozeCapable = true;
  const readAt = "2026-10-12T00:00:00.000Z";
  const until = "2026-10-12T01:00:00.000Z";
  const snoozed = Array.from({ length: 51 }, (_, index) => {
    const taskId = `task-${String(index).padStart(3, "0")}`;
    return decodeRow({
      kind: "task",
      task: { taskId, title: `Snoozed task ${index + 1}`, status: "completed", updatedAt: readAt },
      view: { taskId, pinnedAt: null, doneAt: null, readThrough: null, snoozedUntil: until },
      lastActivityAt: readAt,
      unread: false,
      mainMessagesSinceQuiet: 0,
    });
  });
  const card: GoatBotTaskCard = {
    key: "task-050",
    revision: 1,
    updatedAt: readAt,
    title: "Snoozed task 51",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "No thread" },
  };
  Object.assign(state.task, {
    isPending: false,
    isSuccess: true,
    data: { rows: [], snoozed: snoozed.slice(0, 50), snoozedNextCursor: "cursor", readAt },
  });
  state.checkSnoozes.mockReturnValue("snooze-check");
  const continuation = Promise.withResolvers<unknown>();
  state.snoozePage.mockReturnValue(continuation.promise);
  await render(undefined, undefined, [], [card]);
  await press("Work");
  expect(state.checkSnoozes).toHaveBeenCalledWith({
    environmentId: "env",
    input: { checkSnoozes: ["task-050"] },
  });
  expect(container.textContent).not.toContain("Earlier in chat");
  state.snoozeCheck.data = { activeSnoozes: [{ taskId: ChannelTaskId.make("task-050"), until }] };
  await render(undefined, undefined, [], [card]);
  expect(container.textContent).not.toContain("Earlier in chat");
  await press("Snoozed");
  expect(container.textContent).not.toContain("Snoozed task 51");
  await press("Show more");
  expect(state.snoozePage).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { snoozedAfter: "cursor" },
  });
  const refreshed = (minute: number) => ({
    rows: [],
    snoozed: snoozed.slice(0, 50),
    snoozedNextCursor: "cursor",
    readAt: `2026-10-12T00:0${minute}:00.000Z`,
  });
  state.task.data = refreshed(1);
  await render(undefined, undefined, [], [card]);
  expect(container.querySelector('[aria-label="Show more snoozed tasks"]')).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () =>
    continuation.resolve(
      AsyncResult.success({ rows: [], snoozed: snoozed.slice(50), mainMessageCount: 0 }),
    ),
  );
  expect(container.textContent).toContain("Snoozed task 51");
  state.task.data = refreshed(2);
  await render(undefined, undefined, [], [card]);
  await press("Snoozed task 51");
  expect(state.openTask).toHaveBeenCalledWith("task-050", "Snoozed task 51");
});

it("reloads mobile Home when the Snoozed page has a newer revision", async () => {
  reset();
  state.snoozeCapable = true;
  const at = "2026-10-12T00:00:00.000Z";
  const snoozed = (taskId: string, title: string) =>
    decodeRow({
      kind: "task",
      task: { taskId, title, status: "completed", updatedAt: at },
      view: { taskId, pinnedAt: null, doneAt: null, readThrough: null, snoozedUntil: at },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    });
  const snapshot = (snoozedRevision: string, snoozedNextCursor: string) => ({
    rows: [],
    mainMessageCount: 0,
    snoozed: [snoozed("first", "First snoozed task")],
    snoozedRevision,
    snoozedNextCursor,
  });
  Object.assign(state.task, {
    isSuccess: true,
    isPending: false,
    data: snapshot("before", "old-cursor"),
  });
  state.snoozePage
    .mockResolvedValueOnce(
      AsyncResult.success({
        rows: [],
        mainMessageCount: 0,
        snoozedRevision: "after",
        snoozed: [snoozed("stale", "Stale page")],
      }),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        rows: [],
        mainMessageCount: 0,
        snoozedRevision: "after",
        snoozed: [snoozed("next", "Next snoozed task")],
      }),
    );

  await render();
  await press("Work");
  await press("Snoozed");
  await press("Show more");
  expect(state.task.refresh).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Show more snoozed tasks"]')).toHaveProperty(
    "disabled",
    true,
  );
  expect(container.textContent).not.toContain("Stale page");

  Object.assign(state.task, { isPending: false, data: snapshot("after", "new-cursor") });
  await render();
  await press("Show more");
  expect(container.textContent).toContain("Next snoozed task");
  expect(state.snoozePage.mock.calls.map(([, request]) => request.input.snoozedAfter)).toEqual([
    "old-cursor",
    "new-cursor",
  ]);
});

it("shows a failed snooze check and retries before showing unchecked chat work", async () => {
  reset();
  state.snoozeCapable = true;
  state.checkSnoozes.mockReturnValue("snooze-check");
  state.snoozeCheck.error = "offline";
  Object.assign(state.task, { data: { rows: [] }, isSuccess: true, isPending: false });
  const card: GoatBotTaskCard = {
    key: "old-task",
    revision: 1,
    updatedAt: "2026-10-12T00:00:00.000Z",
    title: "Past work",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "No thread" },
  };
  await render(undefined, undefined, [], [card]);
  await press("Work");
  expect(container.textContent).toContain("Couldn't check snoozed work.");
  expect(container.textContent).not.toContain("No recent tasks");
  expect(container.textContent).not.toContain("Earlier in chat");
  await press("Try again");
  expect(state.snoozeCheck.refresh).toHaveBeenCalledOnce();

  state.snoozeCheck.error = null;
  state.snoozeCheck.data = { activeSnoozes: [] };
  await render(undefined, undefined, [], [card]);
  expect(container.textContent).not.toContain("Couldn't check snoozed work.");
  expect(container.textContent).toContain("Earlier in chat");
});

it("shows empty routines when live data is available while the subscription waits", async () => {
  reset();
  Object.assign(state.routines, { data: { tasks: [] }, isPending: true, isSuccess: false });
  await render();
  await press("Work");
  // Routines sit on Home with machines and work.
  expect(container.textContent).toContain("set up a routine");
  expect(container.textContent).not.toContain("Loading routines");
});

it("keeps known tasks in view while they refresh and after a refresh fails", async () => {
  reset();
  const at = "2026-11-07T10:00:00.000Z";
  const rows = [
    decodeRow({
      kind: "task",
      task: { taskId: "known", title: "Known task", status: "running", updatedAt: at },
      view: { taskId: "known", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  ];
  // A refresh after Pin or Mark done waits on top of the rows already shown.
  Object.assign(state.task, { isPending: true, isSuccess: true, data: { rows } });
  await render();
  await press("Work");
  expect(container.textContent).toContain("Known task");
  expect(container.textContent).not.toContain("Loading tasks");
  Object.assign(state.task, { isPending: false, isSuccess: false, error: "failed" });
  await render();
  expect(container.textContent).toContain("Known task");
  expect(container.textContent).toContain("Couldn't load GOAT Bot's tasks.");
  await press("Try again");
  expect(state.task.refresh).toHaveBeenCalledOnce();
});

it("shows two tabs, Home and Library, and updates their selected state", async () => {
  reset();
  await render();
  await press("Work");
  const buttons = [...container.querySelectorAll("button")];
  for (const gone of ["Tasks", "Routines", "Memory"])
    expect(buttons.some((button) => button.textContent === gone)).toBe(false);
  const tabs = ["Home", "Library"].map((name) =>
    buttons.find((button) => button.textContent === name),
  );
  expect(tabs.every((tab) => tab !== undefined)).toBe(true);
  expect(tabs[0]?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => tabs[1]?.click());
  expect(tabs[0]?.getAttribute("aria-pressed")).toBe("false");
  expect(tabs[1]?.getAttribute("aria-pressed")).toBe("true");
});

it("a refused pause keeps the routine's stored state and shows why", async () => {
  reset();
  Object.assign(state.routines, {
    isPending: false,
    isSuccess: true,
    data: {
      tasks: [
        {
          id: "digest",
          title: "Daily digest",
          prompt: "Summarize the inbox",
          enabled: true,
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
          threadId: "bot",
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "never",
          lastRunError: null,
        },
      ],
    },
  });
  state.setEnabled.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  await render();
  await press("Work");
  // Routines sit on Home with machines and work.
  expect(container.textContent).toContain("Daily at 09:00 · Not scheduled");
  const toggle = container.querySelector<HTMLInputElement>('[aria-label="Pause Daily digest"]');
  await act(async () => toggle?.click());
  expect(state.setEnabled).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { id: "digest", enabled: false },
  });
  expect(container.textContent).toContain("Couldn't pause this routine: Denied");
  expect(toggle?.checked).toBe(true);
});

it("distinguishes task thread loading, missing, offline, and retry states", async () => {
  reset();
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("Loading task");
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render(ChannelTaskId.make("task"));
  // A settled list without the task: it is older work, whose status and actions are in Home.
  expect(container.textContent).toContain(
    "Status and actions for older work are in GOAT Bot's Home.",
  );
  Object.assign(state.task, { error: "failed", isSuccess: false });
  await render(ChannelTaskId.make("task"));
  await press("Couldn't load task");
  expect(state.task.refresh).toHaveBeenCalledOnce();
  state.connected = false;
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("offline");
});

it("shows task details in the header when a card is available for a listed task", async () => {
  reset();
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: { taskId: "task", title: "Review", status: "running", updatedAt: at },
    view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [row] } });
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).not.toContain("Task summary");
  await render(ChannelTaskId.make("task"), <span>Task summary</span>);
  expect(container.textContent).toContain("Task summary");
});

it("names a task the server no longer lists from its conversation card, as older work", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await renderWork(
    <WorkWithChip
      visible
      taskId={ChannelTaskId.make("task-old")}
      taskCardInfo={{
        key: "task-old",
        revision: 1,
        updatedAt: "2026-11-11T02:00:00.000Z",
        title: "Summarize the README",
        statusLabel: "Needs your input",
        tone: "attention",
        sourceLabel: null,
        summary: null,
        attentionLabel: null,
        pullRequests: [],
        target: { kind: "none", label: "No thread" },
      }}
      taskCard={<span>Needs your input</span>}
      onOpenTask={() => {}}
      onOpenThread={state.openThread}
    />,
  );
  expect(container.textContent).toContain("Summarize the README");
  expect(container.textContent).toContain(
    "Status and actions for older work are in GOAT Bot's Home.",
  );
  expect(container.textContent).not.toContain("Needs your input");
  expect(container.textContent).not.toContain("Task not found");
});

const decodeRow = Schema.decodeUnknownSync(BotThreadRow);

it("shows Done and offers reopening for a task marked done", async () => {
  reset();
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: { taskId: "task", title: "Review", status: "running", updatedAt: at },
    view: { taskId: "task", pinnedAt: null, doneAt: at, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [row] } });
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("Done");
  expect(container.textContent).toContain("Reopen");
});

const routine = (id: string, lastRunStatus: string) => ({
  id,
  title: id === "failed" ? "Morning digest" : "Evening digest",
  prompt: "Summarize the inbox",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
  threadId: "bot",
  nextRunAt: null,
  lastRunAt: "2026-11-07T08:00:00.000Z",
  lastRunStatus,
  lastRunError: lastRunStatus === "failed" ? "Provider exited with code 1" : null,
});

it("runs a healthy or paused timer on demand and gives webhook routines delivery guidance", async () => {
  reset();
  const timer = { ...routine("fine", "succeeded"), enabled: false };
  const trigger = {
    ...routine("hook", "failed"),
    title: "PR delivery",
    schedule: { type: "webhook" },
    routineMode: "work",
  };
  Object.assign(state.routines, {
    isPending: false,
    isSuccess: true,
    data: { tasks: [timer, trigger] },
  });
  state.runNow.mockResolvedValue(AsyncResult.success({ task: timer }));
  await render();
  await press("Work");
  const runButtons = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Run now",
  );
  expect(runButtons).toHaveLength(1);
  expect(container.textContent).toContain("Signed deliveries to the webhook URL start work");
  await act(async () => runButtons[0]?.click());
  expect(state.runNow).toHaveBeenCalledOnce();
  expect(state.runNow).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { id: "fine" },
  });
});

it("retries a failed task from its screen, names the attempt, and shows a refusal", async () => {
  reset();
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: { taskId: "task", title: "Review", status: "failed", updatedAt: at, generation: 2 },
    view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [row] } });
  state.retry.mockResolvedValueOnce(
    AsyncResult.success({ status: "started", taskId: "task", generation: 3 }),
  );
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("Failed · Attempt 2");
  await press("Retry");
  expect(state.retry).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { taskId: "task", clientRequestId: expect.any(String) },
  });
  expect(state.task.refresh).toHaveBeenCalledOnce();
  state.retry.mockResolvedValueOnce(
    AsyncResult.success({ status: "refused", taskId: "task", reason: "elsewhere" }),
  );
  await press("Retry");
  expect(container.textContent).toContain(
    "This ran on another computer. Check it there, then ask again in chat.",
  );
  expect(state.task.refresh).toHaveBeenCalledOnce();
});

it("Library shows its own view", async () => {
  reset();
  await render();
  await press("Work");
  await press("Library");
  expect(container.textContent).toContain("Files need a newer GOAT server.");
});

it("opens the coding thread a task launched, such as a bot turn's", async () => {
  reset();
  state.openThread.mockClear();
  const at = "2026-11-07T10:00:00.000Z";
  const rows = [
    decodeRow({
      kind: "task",
      task: { taskId: "turn", title: "Start one task", status: "running", updatedAt: at },
      view: { taskId: "turn", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
    decodeRow({
      kind: "coding",
      taskId: "turn",
      environmentId: "env",
      threadId: "thread:child",
      state: "bound",
      lastActivityAt: at,
    }),
  ];
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows } });
  await render(ChannelTaskId.make("turn"));
  await press("Open work thread");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "thread:child" });
});

it("keeps a turn's coding thread out of the Work card", async () => {
  reset();
  state.openThread.mockClear();
  const at = "2026-11-07T10:00:00.000Z";
  const rows = [
    decodeRow({
      kind: "task",
      task: { taskId: "turn", title: "Start one task", status: "running", updatedAt: at },
      view: { taskId: "turn", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
    decodeRow({
      kind: "coding",
      taskId: "turn",
      environmentId: "env",
      threadId: "thread:child",
      title: "Echo question probe",
      state: "bound",
      lastActivityAt: at,
    }),
  ];
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows } });
  await render();
  await press("Work");
  expect(container.textContent).toContain("Start one task");
  expect(container.textContent).not.toContain("Echo question probe");
  expect(state.openThread).not.toHaveBeenCalled();
});

it("points to the chat from Tasks when the bot asked a question there", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render(undefined, undefined, ["turn-1"]);
  await press("Work");
  expect(container.textContent).toContain("GOAT Bot is waiting for your answer in the chat");
  expect(container.textContent).toContain("No recent tasks");
  await press("Open the chat");
  expect(container.textContent).not.toContain("waiting for your answer in the chat");
});

it("offers the Work sheet, and with it Open the chat, only on the chat screen", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render(ChannelTaskId.make("task-1"), undefined, ["turn-1"]);
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Work"),
  ).toBe(false);
  expect(container.textContent).not.toContain("waiting for your answer in the chat");
});

it("draws the bot's face in the chip Android shows above the chat: its initial, colour and state", async () => {
  reset();
  nativePlatform.OS = "android";
  const chipFace = (activity: { state: "working" } | null) => (
    <GoatBotChipFace
      activity={activity}
      emoji="S"
      accent={{ background: "#6D28D9", foreground: "#FFFFFF" }}
      conversation={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("scout") }}
    />
  );
  const face = () => {
    const chip = [...container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === "GOAT Bot",
    );
    return chip?.querySelector("div.rounded-full.border") ?? null;
  };
  // The member's colour fills the circle, or, inside a ring, the circle within the ring's gap.
  const fill = () =>
    [face(), ...(face()?.querySelectorAll("div") ?? [])].find(
      (item) => (item as HTMLElement | null)?.style.backgroundColor,
    ) as HTMLElement | undefined;
  try {
    await render(undefined, undefined, [], [], chipFace({ state: "working" }));
    // The member's initial on its colour, with the ring a working bot shows, parted from the
    // colour by the chip's own fill.
    expect(face()?.textContent).toBe("S");
    expect(fill()?.style.backgroundColor).toBe("rgb(109, 40, 217)");
    expect(fill()).not.toBe(face());
    expect(face()?.className).toContain("border-primary");
    expect(face()?.className).toContain("bg-goat-bot-message");
    await render(undefined, undefined, [], [], chipFace(null));
    expect(face()?.className).toContain("border-transparent");
    expect(fill()).toBe(face());
  } finally {
    nativePlatform.OS = "ios";
  }
});
