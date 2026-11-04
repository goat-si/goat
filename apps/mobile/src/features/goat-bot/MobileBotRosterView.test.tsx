import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";

vi.mock("react-native", () => ({
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
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean };
  }) => (
    <button onClick={onPress} disabled={disabled} aria-pressed={accessibilityState?.selected}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled }: { label: string; disabled?: boolean }) => (
    <button disabled={disabled}>{label}</button>
  ),
}));
import { MobileBotRosterView, MobileHomeSegments } from "./MobileBotRosterView";

const at = "2026-11-04T10:00:00.000Z";
const task = Schema.decodeUnknownSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "task", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
});
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

it("switches both segments and exposes the selected state", async () => {
  function Harness() {
    const [mode, setMode] = React.useState<"bot" | "thread">("thread");
    return <MobileHomeSegments mode={mode} onSelect={setMode} />;
  }
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  const [bots, threads] = container.querySelectorAll("button");
  expect(threads?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => bots?.click());
  expect(bots?.getAttribute("aria-pressed")).toBe("true");
  expect(threads?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => threads?.click());
  expect(threads?.getAttribute("aria-pressed")).toBe("true");
  expect(bots?.getAttribute("aria-pressed")).toBe("false");
});

it("renders the main bot, child task and disabled creation action", async () => {
  const open = vi.fn();
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        rows={[task]}
        hasMore
        slackEnabled
        preview="Latest reply"
        unread
        onOpenBot={() => {}}
        onOpenChild={open}
        onLongPressTask={() => {}}
        onShowMore={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("GOAT Bot  ·  Main  ·  Slack");
  expect(container.textContent).toContain("Review");
  expect(container.textContent).toContain("waiting input");
  expect(container.textContent).toContain("Show more");
  expect(container.querySelector("button:disabled")?.textContent).toContain("Coming soon");
  const taskButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Review"),
  );
  await act(async () => taskButton?.click());
  expect(open).toHaveBeenCalledWith(task);
});

const state = vi.hoisted(() => ({
  connected: true,
  task: {
    data: null as null | { rows: never[] },
    error: null as string | null,
    isPending: true,
    isSuccess: false,
    refresh: vi.fn(),
  },
  routines: {
    data: null as null | { tasks: never[] },
    error: null as string | null,
    isPending: true,
    isSuccess: false,
    refresh: vi.fn(),
  },
}));

vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotThreads: () => "task",
    listChildWork: () => "child",
    updateTaskView: {},
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => "routines" },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      ["env", { serverConfig: { environment: { capabilities: { goatBotTaskThreads: true } } } }],
    ]),
  }),
}));
vi.mock("./goatBotHomeMode", () => ({
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: state.connected }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "task"
      ? state.task
      : key === "routines"
        ? state.routines
        : { data: null, error: null, isPending: false, isSuccess: false, refresh: vi.fn() },
}));
import { MobileBotWork } from "./MobileBotWork";

function reset() {
  state.connected = true;
  for (const query of [state.task, state.routines])
    Object.assign(query, { data: null, error: null, isPending: true, isSuccess: false });
  state.task.refresh.mockClear();
  state.routines.refresh.mockClear();
}
async function render(taskId?: ChannelTaskId, taskCard?: ReactNode) {
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotWork visible taskId={taskId} taskCard={taskCard} onOpenTask={() => {}} />,
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
