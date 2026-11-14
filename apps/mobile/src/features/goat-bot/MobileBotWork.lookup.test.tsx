import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { useState } from "react";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { resetTaskReadAcknowledgementsForTests } from "@goat/client-runtime/goatBot";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

const nativePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  Platform: nativePlatform,
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Easing: { linear: (value: number) => value },
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1 },
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
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <div className={className} style={style} aria-label={accessibilityLabel}>
      {children}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: (props: { accessibilityLabel?: string }) => (
    <input aria-label={props.accessibilityLabel} />
  ),
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
// The row menu is native; these tests do not open it.
vi.mock("./MobileBotRowMenu", () => ({
  MobileBotRowMenu: (props: { label: string; row?: ReactNode }) => (
    <>
      {props.row}
      <button aria-label={props.label} />
    </>
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
  // A server that looks tasks up by id and searches their titles.
  lookupCapable: false,
  lookup: vi.fn(),
  update: vi.fn(),
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
    // Home's shared current work; its links are not read in this file.
    homeCurrentOpenableWorkAtom: () => "home-current",
    listBotThreads: () => "task",
    listChildWork: () => "child",
    listBotArtifacts: () => "artifacts",
    readBotArtifact: {},
    listTasks: () => "computer",
    updateTaskView: { label: "update", permissionAtom: () => "permission", run: state.update },
    retryTask: { label: "retry", permissionAtom: () => "permission", run: state.retry },
    getBotTask: { label: "lookup", permissionAtom: () => "permission", run: state.lookup },
    searchBotTasks: { label: "search", permissionAtom: () => "permission" },
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
            environment: {
              capabilities: {
                goatBotTaskThreads: true,
                goatBotTaskRetry: true,
                goatBotChildWork: true,
                goatBotMembers: true,
                goatBotTaskLookupSearch: state.lookupCapable,
              },
            },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
vi.mock("./goatBotHomeMode", async (original) => ({
  ...(await original<typeof import("./goatBotHomeMode")>()),
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: state.connected }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "task"
      ? // As the real query: a success counts only once settled, not while a read is waiting.
        { ...state.task, successResult: state.task.isSuccess && !state.task.isPending ? {} : null }
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
  state.task.refresh.mockReset();
  // As the real query: asking again leaves the list waiting until a test settles it.
  state.task.refresh.mockImplementation(() => Object.assign(state.task, { isPending: true }));
  state.routines.refresh.mockClear();
  state.setEnabled.mockReset();
  state.runNow.mockReset();
  state.retry.mockReset();
  state.lookupCapable = false;
  state.lookup.mockReset();
  state.update.mockReset();
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
const decodeRow = Schema.decodeUnknownSync(BotThreadRow);

const lookedUp = (status: "completed" | "running") => ({
  task: {
    state: "known",
    row: {
      kind: "task",
      task: {
        taskId: "task-old",
        title: "Summarize the README",
        status,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
      view: { taskId: "task-old", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: "2026-11-01T00:00:00.000Z",
      unread: false,
      mainMessagesSinceQuiet: 0,
    },
  },
  codingRows: [],
  remoteWork: [],
  launchesTruncated: false,
  partial: false,
});

it("looks up a task the current list does not hold, shows its status and actions, and reads it again after a change", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await render(ChannelTaskId.make("task-old"));
  expect(state.lookup).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { taskId: "task-old", botId: "main" },
  });
  expect(container.textContent).toContain("Summarize the README");
  expect(container.textContent).toContain("Done");
  expect(container.textContent).not.toContain("Status and actions for older work");
  await press("Pin");
  expect(state.update).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { taskId: "task-old", pinned: true },
  });
  expect(state.task.refresh).toHaveBeenCalledOnce();
  // The task is read again once the list read the action started has settled.
  expect(state.lookup).toHaveBeenCalledTimes(1);
  Object.assign(state.task, { isPending: false });
  await render(ChannelTaskId.make("task-old"));
  expect(state.lookup).toHaveBeenCalledTimes(2);
});

it("offers task search on Home only while the computer can search and is connected", async () => {
  reset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  const field = () => container.querySelector('input[aria-label="Search GOAT Bot\'s tasks"]');
  await render();
  await press("Work");
  expect(field()).toBeNull();
  state.lookupCapable = true;
  await render();
  expect(field()).not.toBeNull();
  state.connected = false;
  await render();
  expect(field()).toBeNull();
});

it("a task the current list already holds shows its current row and is not looked up", async () => {
  reset();
  state.lookupCapable = true;
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
  expect(container.textContent).toContain("Review");
  expect(state.lookup).not.toHaveBeenCalled();
});

it("a member's older task is looked up as that member's", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={ChannelTaskId.make("task-old")}
        member={{
          botId: BotId.make("scout"),
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("scout-thread"),
          name: "Scout",
          defaultModelSelection: null,
        }}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    ),
  );
  expect(state.lookup).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { taskId: "task-old", botId: "scout" },
  });
});

it("an older task marked read on its screen is read again, so it no longer shows as unread", async () => {
  reset();
  resetTaskReadAcknowledgementsForTests();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  const unread = lookedUp("completed");
  Object.assign(unread.task.row, { unread: true, lastActivityAt: "2026-11-02T00:00:00.000Z" });
  state.lookup.mockResolvedValueOnce(AsyncResult.success(unread));
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await render(ChannelTaskId.make("task-old"));
  expect(state.update).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: { taskId: "task-old", readThrough: "2026-11-02T00:00:00.000Z" },
  });
  Object.assign(state.task, { isPending: false });
  await render(ChannelTaskId.make("task-old"));
  expect(state.lookup).toHaveBeenCalledTimes(2);
});

it("a read mark that settles after the screen moved to another bot does not reread that bot's task", async () => {
  reset();
  resetTaskReadAcknowledgementsForTests();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  const unread = lookedUp("completed");
  Object.assign(unread.task.row, { unread: true, lastActivityAt: "2026-11-02T00:00:00.000Z" });
  state.lookup.mockResolvedValueOnce(AsyncResult.success(unread));
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  let settle: (value: unknown) => void = () => {};
  state.update.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  await render(ChannelTaskId.make("task-old"));
  expect(state.update).toHaveBeenCalledOnce();
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={ChannelTaskId.make("task-old")}
        member={{
          botId: BotId.make("scout"),
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("scout-thread"),
          name: "Scout",
          defaultModelSelection: null,
        }}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    ),
  );
  expect(state.lookup).toHaveBeenCalledTimes(2);
  await act(async () => settle(AsyncResult.success({})));
  expect(state.lookup).toHaveBeenCalledTimes(2);
});

it("looks nothing up until the current list has settled, and not when the settled list holds the task", async () => {
  reset();
  state.lookupCapable = true;
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: { taskId: "task", title: "Review", status: "running", updatedAt: at },
    view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  await render(ChannelTaskId.make("task"));
  // A list being read again still holds its earlier answer, which lacks the task.
  Object.assign(state.task, { isPending: true, isSuccess: true, data: { rows: [] } });
  await render(ChannelTaskId.make("task"));
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [row] } });
  await render(ChannelTaskId.make("task"));
  expect(container.textContent).toContain("Review");
  expect(state.lookup).not.toHaveBeenCalled();
});

it("a looked-up task stays on screen while the current list refreshes, with no second lookup", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await render(ChannelTaskId.make("task-old"));
  expect(state.lookup).toHaveBeenCalledOnce();
  Object.assign(state.task, { isPending: true });
  await render(ChannelTaskId.make("task-old"));
  expect(container.textContent).toContain("Summarize the README");
  expect(container.textContent).toContain("Done");
  Object.assign(state.task, { isPending: false });
  await render(ChannelTaskId.make("task-old"));
  expect(container.textContent).toContain("Summarize the README");
  expect(state.lookup).toHaveBeenCalledOnce();
  const at = "2026-11-04T10:00:00.000Z";
  const row = decodeRow({
    kind: "task",
    task: {
      taskId: "task-old",
      title: "Summarize the README now",
      status: "running",
      updatedAt: at,
    },
    view: { taskId: "task-old", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  Object.assign(state.task, { data: { rows: [row] } });
  await render(ChannelTaskId.make("task-old"));
  expect(container.textContent).toContain("Summarize the README now");
  expect(state.lookup).toHaveBeenCalledOnce();
});

const listRow = (taskId: string, title: string) =>
  decodeRow({
    kind: "task",
    task: { taskId, title, status: "running", updatedAt: "2026-11-04T10:00:00.000Z" },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
const lookups = (taskId: string) =>
  state.lookup.mock.calls.filter((call) => call[1]?.input?.taskId === taskId).length;

it("moving to another task while the list refreshes waits for the refresh, and a task it returns is not looked up", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await render(ChannelTaskId.make("task-old"));
  expect(lookups("task-old")).toBe(1);
  Object.assign(state.task, { isPending: true });
  await render(ChannelTaskId.make("task-b"));
  expect(lookups("task-b")).toBe(0);
  Object.assign(state.task, { isPending: false, data: { rows: [listRow("task-b", "Task B")] } });
  await render(ChannelTaskId.make("task-b"));
  expect(container.textContent).toContain("Task B");
  expect(lookups("task-b")).toBe(0);
});

it("an action's reread waits for its list refresh, also a failed one, then reads that task once", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await render(ChannelTaskId.make("task-old"));
  await press("Pin");
  Object.assign(state.task, { isPending: true });
  await render(ChannelTaskId.make("task-old"));
  expect(lookups("task-old")).toBe(1);
  expect(container.textContent).toContain("Summarize the README");
  Object.assign(state.task, { isPending: false, isSuccess: false, error: "failed" });
  await render(ChannelTaskId.make("task-old"));
  expect(container.textContent).toContain("Summarize the README");
  expect(lookups("task-old")).toBe(2);
  await render(ChannelTaskId.make("task-old"));
  expect(lookups("task-old")).toBe(2);
});

it("an action's reread is dropped when the screen moves to another task first", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await render(ChannelTaskId.make("task-old"));
  await press("Pin");
  Object.assign(state.task, { isPending: true });
  await render(ChannelTaskId.make("task-b"));
  Object.assign(state.task, { isPending: false, data: { rows: [listRow("task-b", "Task B")] } });
  await render(ChannelTaskId.make("task-b"));
  expect(lookups("task-old")).toBe(1);
  expect(lookups("task-b")).toBe(0);
});

it("the Try again control pressed twice at once reads the task once", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(
    AsyncResult.failure(Cause.fail({ _tag: "ChannelGatewayError", reason: "persistence_failed" })),
  );
  await render(ChannelTaskId.make("task-old"));
  const retry = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Couldn't load this task. Try again"),
  );
  expect(retry).toBeDefined();
  state.lookup.mockReturnValue(new Promise(() => {}));
  await act(async () => {
    retry?.click();
    retry?.click();
  });
  expect(lookups("task-old")).toBe(2);
});

it("a Pin that completes after the screen moved to another bot's task with the same id rereads nothing there", async () => {
  reset();
  state.lookupCapable = true;
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  let settle: (value: unknown) => void = () => {};
  state.update.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  await render(ChannelTaskId.make("task-old"));
  await press("Pin");
  const asMember = () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={ChannelTaskId.make("task-old")}
        member={{
          botId: BotId.make("scout"),
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("scout-thread"),
          name: "Scout",
          defaultModelSelection: null,
        }}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    );
  await act(async () => asMember());
  const scout = () =>
    state.lookup.mock.calls.filter((call) => call[1]?.input?.botId === "scout").length;
  expect(scout()).toBe(1);
  await act(async () => settle(AsyncResult.success({})));
  Object.assign(state.task, { isPending: false });
  await act(async () => asMember());
  expect(scout()).toBe(1);
});
