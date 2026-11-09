import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Switch: ({
    value,
    disabled,
    accessibilityLabel,
    onValueChange,
  }: {
    value?: boolean;
    disabled?: boolean;
    accessibilityLabel?: string;
    onValueChange?: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      role="switch"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={() => onValueChange?.(!value)}
    />
  ),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  Alert: { alert: vi.fn() },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityState,
    accessibilityActions,
    accessibilityLabel,
    onAccessibilityAction,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean; expanded?: boolean };
    accessibilityActions?: { name: string; label: string }[];
    accessibilityLabel?: string;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-pressed={accessibilityState?.selected}
      aria-expanded={accessibilityState?.expanded}
      aria-label={accessibilityLabel}
      data-actions={accessibilityActions?.map((item) => item.name).join(",")}
      onKeyDown={(event) => onAccessibilityAction?.({ nativeEvent: { actionName: event.key } })}
    >
      {children}
    </button>
  ),
}));
const state = vi.hoisted(() => ({
  connected: true,
  task: {
    data: null as null | { rows: BotThreadRow[] },
    error: null as string | null,
    isPending: true,
    isSuccess: false,
    refresh: vi.fn(),
  },
  routines: {
    data: null as null | { tasks: unknown[] },
    error: null as string | null,
    isPending: true,
    isSuccess: false,
    refresh: vi.fn(),
  },
  setEnabled: vi.fn(),
  runNow: vi.fn(),
  retry: vi.fn(),
  openThread: vi.fn(),
  memberModel: null as null | Record<string, unknown>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
// The header's trailing items render as buttons, so tests press Work where iOS shows it.
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({
    options,
  }: {
    options: {
      unstable_headerRightItems: () => {
        label: string;
        accessibilityLabel: string;
        onPress: () => void;
      }[];
    };
  }) =>
    options.unstable_headerRightItems().map((item) => (
      <button
        key={item.label}
        data-header-item
        aria-label={item.accessibilityLabel}
        onClick={item.onPress}
      >
        {item.label}
      </button>
    )),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotThreads: () => "task",
    listChildWork: () => "child",
    listBotArtifacts: () => "artifacts",
    readBotArtifact: {},
    listTasks: () => "computer",
    updateTaskView: {},
    retryTask: { label: "retry", permissionAtom: () => "permission", run: state.retry },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => "routines",
    setScheduledTaskEnabled: {
      label: "set enabled",
      permissionAtom: () => "permission",
      run: state.setEnabled,
    },
    runScheduledTaskNow: {
      label: "run now",
      permissionAtom: () => "permission",
      run: state.runNow,
    },
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          serverConfig: {
            environment: { capabilities: { goatBotTaskThreads: true, goatBotTaskRetry: true } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
vi.mock("./goatBotHomeMode", () => ({
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: state.connected }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => null }));
// The Android menu needs native modules; iOS builds the model into the header items below.
vi.mock("./GoatBotMemberModelAndroidMenu", () => ({ GoatBotMemberModelAndroidMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({
  useMobileGoatBotMemberModelMenu: () => state.memberModel,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "task"
      ? state.task
      : key === "routines"
        ? state.routines
        : {
            data: null,
            cause: null,
            error: null,
            isPending: false,
            isSuccess: false,
            refresh: vi.fn(),
          },
}));
import { MobileBotWork } from "./MobileBotWork";
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

function reset() {
  state.connected = true;
  state.memberModel = null;
  for (const query of [state.task, state.routines])
    Object.assign(query, { data: null, error: null, isPending: true, isSuccess: false });
  state.task.refresh.mockClear();
  state.routines.refresh.mockClear();
  state.setEnabled.mockReset();
  state.runNow.mockReset();
  state.retry.mockReset();
}
async function render(
  taskId?: ChannelTaskId,
  taskCard?: ReactNode,
  turnsWaiting: readonly string[] = [],
) {
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotWork
        visible
        taskId={taskId}
        taskCard={taskCard}
        turnsWaiting={turnsWaiting}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    ),
  );
}
async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}
it("distinguishes task and routine loading, empty, offline, and retry states", async () => {
  reset();
  await render();
  await press("Work");
  expect(container.textContent).toContain("Loading tasks");
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render();
  expect(container.textContent).toContain("No tasks yet");
  Object.assign(state.task, { error: "failed", isSuccess: false });
  await render();
  await press("Couldn't load tasks");
  expect(state.task.refresh).toHaveBeenCalledOnce();
  await press("Routines");
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

it("shows empty routines when live data is available while the subscription waits", async () => {
  reset();
  Object.assign(state.routines, { data: { tasks: [] }, isPending: true, isSuccess: false });
  await render();
  await press("Work");
  await press("Routines");
  expect(container.textContent).toContain("set up a routine");
  expect(container.textContent).not.toContain("Loading routines");
});

it("exposes work tabs as buttons and updates their selected state", async () => {
  reset();
  await render();
  await press("Work");
  const buttons = [...container.querySelectorAll("button")];
  const tabs = ["Tasks", "Routines", "Memory", "Library", "Computer"].map((name) =>
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
  await press("Routines");
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
  expect(container.textContent).toContain("Task not found");
  Object.assign(state.task, { error: "failed", isSuccess: false });
  await render(ChannelTaskId.make("task"));
  await press("Couldn't load task");
  expect(state.task.refresh).toHaveBeenCalledOnce();
  state.connected = false;
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("offline");
});

it("shows task details in the header when a card is available", async () => {
  reset();
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).not.toContain("Task summary");
  await render(ChannelTaskId.make("task"), <span>Task summary</span>);
  expect(container.textContent).toContain("Task summary");
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

it("offers Run now only for a routine whose last run failed, one run per tap", async () => {
  reset();
  Object.assign(state.routines, {
    isPending: false,
    isSuccess: true,
    data: { tasks: [routine("failed", "failed"), routine("fine", "succeeded")] },
  });
  state.runNow.mockResolvedValue(AsyncResult.success({ task: routine("failed", "failed") }));
  await render();
  await press("Work");
  await press("Routines");
  const runButtons = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Run now",
  );
  expect(runButtons).toHaveLength(1);
  await act(async () => runButtons[0]?.click());
  expect(state.runNow).toHaveBeenCalledOnce();
  expect(state.runNow).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { id: "failed" },
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

it("Library and Computer show their own views", async () => {
  reset();
  await render();
  await press("Work");
  await press("Library");
  expect(container.textContent).toContain("Files need a newer GOAT server.");
  await press("Computer");
  expect(container.textContent).toContain("Loading machines…");
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

it("lists a turn's coding thread under it in Tasks and opens it", async () => {
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
  await press("Echo question probe");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "thread:child" });
  expect(container.textContent).not.toContain("Echo question probe");
});

it("points to the chat from Tasks when the bot asked a question there", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  await render(undefined, undefined, ["turn-1"]);
  await press("Work");
  expect(container.textContent).toContain("GOAT Bot is waiting for your answer in the chat");
  expect(container.textContent).toContain("No tasks yet");
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

it("puts a member's model beside Work in its chat header", async () => {
  reset();
  state.memberModel = {
    label: "GPT-6-Luna",
    accessibilityLabel: "Research model: GPT-6-Luna",
    title: "Research's model",
    canChange: true,
    items: [],
    select: () => {},
  };
  await render();
  const header = [...container.querySelectorAll("[data-header-item]")];
  expect(header.map((item) => item.textContent)).toEqual(["Work", "GPT-6-Luna"]);
  expect(header[1]?.getAttribute("aria-label")).toBe("Research model: GPT-6-Luna");
});
