import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { useState } from "react";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

const nativePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  Platform: nativePlatform,
  Easing: { linear: (value: number) => value },
  StyleSheet: { absoluteFill: {} },
  useAnimatedValue: () => ({ setValue: () => {}, interpolate: () => 0 }),
  Animated: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    timing: () => ({}),
    loop: () => ({ start: () => {}, stop: () => {} }),
  },
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
  View: ({
    children,
    className,
    style,
  }: {
    children?: ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <div className={className} style={style}>
      {children}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FlatList: (
    props: {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    } & Record<string, unknown>,
  ) => (
    <div>
      {props.data.map((item, index) => (
        <div key={item.key}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
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
}));

// The real face module draws the chip's face; only its native drawing and styling stand in.
vi.mock("react-native-reanimated", () => {
  const chain = { duration: () => chain, reduceMotion: () => chain };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    FadeIn: chain,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("uniwind", () => ({
  withUniwind: (component: unknown) => component,
  useResolveClassNames: () => ({ backgroundColor: "#f3f3f3" }),
}));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
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
// The task card's renderer pulls in the native Markdown view, which cannot load under Vitest.
vi.mock("./GoatBotTaskRow", () => ({ GoatBotTaskRow: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadDetail: () => ({ data: { _tag: "None" }, status: "empty", error: { _tag: "None" } }),
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("./GoatBotMarkdown", () => ({
  GoatBotMarkdown: (props: { text: string }) => <span>{props.text}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
import { MobileBotWork } from "./MobileBotWork";
import { GoatBotChipFace } from "./GoatBotFace";

// The chat's header chip opens the home; this stands in for it.
function WorkWithChip(props: Omit<Parameters<typeof MobileBotWork>[0], "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {props.taskId === undefined ? <button onClick={() => setOpen(true)}>Work</button> : null}
      <MobileBotWork {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

function reset() {
  state.connected = true;
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
  chatTasks: ReadonlyArray<GoatBotTaskCard> = [],
  chipFace?: ReactNode,
) {
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={taskId}
        taskCard={taskCard}
        turnsWaiting={turnsWaiting}
        chatTasks={chatTasks}
        chipFace={chipFace}
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
  // The last read was empty, but a failed read says nothing about whether tasks exist now.
  expect(container.textContent).not.toContain("No tasks yet");
  await press("Couldn't load tasks");
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
  expect(container.textContent).toContain("Loading tasks");
  expect(container.textContent).toContain("Earlier in chat");
  Object.assign(state.task, { isPending: false, error: "failed" });
  await render(undefined, undefined, [], [card]);
  expect(container.textContent).toContain("Couldn't load tasks");
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
  await press("Couldn't load tasks");
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

it("names a task the server no longer lists from its conversation card, not as missing", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={ChannelTaskId.make("task-old")}
        taskCardInfo={{ title: "Summarize the README", statusLabel: "Needs your input" }}
        taskCard={<span>Connect mac-mini to open</span>}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    ),
  );
  expect(container.textContent).toContain("Summarize the README");
  expect(container.textContent).toContain("Needs your input");
  expect(container.textContent).toContain("Connect mac-mini to open");
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
  // Routines sit on Home with machines and work.
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
