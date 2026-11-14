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
  // The computer the screen's bot lives on, and whether this device may change task views.
  environmentId: "env",
  canUpdate: true,
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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "update-permission" ? state.canUpdate : true),
}));
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
    // One list per computer and bot, so a test can count each one's refreshes.
    listBotThreads: (key: { environmentId: string; input: { botId?: string } }) =>
      `task:${key.environmentId}:${key.input.botId ?? "main"}`,
    listChildWork: () => "child",
    listBotArtifacts: () => "artifacts",
    readBotArtifact: {},
    listTasks: () => "computer",
    updateTaskView: {
      label: "update",
      permissionAtom: () => "update-permission",
      run: state.update,
    },
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
vi.mock("../../state/environments", () => {
  const presentation = () => ({
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
  });
  return {
    useEnvironments: () => ({
      presentationById: new Map([
        ["env", presentation()],
        ["env2", presentation()],
      ]),
    }),
  };
});
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
vi.mock("./goatBotHomeMode", async (original) => ({
  ...(await original<typeof import("./goatBotHomeMode")>()),
  pickMobileGoatBotEnvironment: () => ({
    environmentId: state.environmentId,
    connected: state.connected,
  }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key?.startsWith("task:")
      ? // As the real query: a success counts only once settled, not while a read is waiting.
        {
          ...state.task,
          successResult: state.task.isSuccess && !state.task.isPending ? {} : null,
          refresh: () => state.task.refresh(key),
        }
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

function WorkWithChip(props: Omit<Parameters<typeof MobileBotWork>[0], "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return <MobileBotWork {...props} open={open} onOpenChange={setOpen} />;
}
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

function reset() {
  resetTaskReadAcknowledgementsForTests();
  state.connected = true;
  state.environmentId = "env";
  state.canUpdate = true;
  state.lookupCapable = true;
  for (const query of [state.task, state.routines])
    Object.assign(query, { data: null, error: null, isPending: true, isSuccess: false });
  state.task.refresh.mockReset();
  // As the real query: asking again leaves the list waiting until a test settles it.
  state.task.refresh.mockImplementation(() => Object.assign(state.task, { isPending: true }));
  state.retry.mockReset();
  state.lookup.mockReset();
  state.update.mockReset();
  Object.assign(state.task, { isPending: false, isSuccess: true, data: { rows: [] } });
}
const scout = {
  botId: BotId.make("scout"),
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("scout-thread"),
  name: "Scout",
  defaultModelSelection: null,
};
async function show(taskId: string, member?: typeof scout) {
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        taskId={ChannelTaskId.make(taskId)}
        {...(member ? { member } : {})}
        onOpenTask={() => {}}
        onOpenThread={state.openThread}
      />,
    ),
  );
}
/** Settles the bot's list as it is now, so a reread that waits for it can start. */
async function settleList(taskId: string, member?: typeof scout) {
  Object.assign(state.task, { isPending: false });
  await show(taskId, member);
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);
async function press(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => target?.click());
}
const text = () => container.textContent ?? "";
const refreshes = (environmentId: string, botId: string) =>
  state.task.refresh.mock.calls.filter((call) => call[0] === `task:${environmentId}:${botId}`)
    .length;
const lookups = (environmentId: string, botId: string, taskId: string) =>
  state.lookup.mock.calls.filter(
    (call) =>
      call[1]?.environmentId === environmentId &&
      call[1]?.input?.botId === botId &&
      call[1]?.input?.taskId === taskId,
  ).length;
const decodeRow = Schema.decodeUnknownSync(BotThreadRow);
const at = "2026-11-01T00:00:00.000Z";
const lookedUp = (
  status: "completed" | "running" | "failed",
  view: { pinnedAt?: string; unread?: boolean } = {},
) => ({
  task: {
    state: "known",
    row: {
      kind: "task",
      task: { taskId: "task-old", title: "Summarize the README", status, updatedAt: at },
      view: {
        taskId: "task-old",
        pinnedAt: view.pinnedAt ?? null,
        doneAt: null,
        readThrough: null,
      },
      lastActivityAt: "2026-11-02T00:00:00.000Z",
      unread: view.unread === true,
      mainMessagesSinceQuiet: 0,
    },
  },
  codingRows: [],
  remoteWork: [],
  launchesTruncated: false,
  partial: false,
});
const listRow = (taskId: string, title: string) =>
  decodeRow({
    kind: "task",
    task: { taskId, title, status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
const failure = (reason: string) =>
  AsyncResult.failure(Cause.fail({ _tag: "ChannelGatewayError", reason }));
function deferred() {
  let settle: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => (settle = resolve));
  return { promise, settle };
}

it("a reread that fails after an action shows the error with Try again, not the old actions; Try again shows the new state", async () => {
  reset();
  state.lookup
    .mockResolvedValueOnce(AsyncResult.success(lookedUp("completed")))
    .mockResolvedValueOnce(failure("persistence_failed"))
    .mockResolvedValueOnce(AsyncResult.success(lookedUp("completed", { pinnedAt: at })));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await show("task-old");
  await press("Pin");
  await settleList("task-old");
  expect(lookups("env", "main", "task-old")).toBe(2);
  expect(text()).toContain("Couldn't load this task. Try again");
  expect(button("Pin")).toBeUndefined();
  expect(button("Mark done")).toBeUndefined();
  await press("Couldn't load this task. Try again");
  expect(lookups("env", "main", "task-old")).toBe(3);
  expect(button("Unpin")).toBeDefined();
});

type Change = "task" | "bot" | "computer";
async function moveAway(change: Change) {
  if (change === "task") {
    Object.assign(state.task, { data: { rows: [listRow("task-b", "Task B")] } });
    await show("task-b");
  } else if (change === "bot") await show("task-old", scout);
  else {
    state.environmentId = "env2";
    await show("task-old");
  }
}
const completions = {
  Pin: async () => {
    state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
    const sent = deferred();
    state.update.mockReturnValueOnce(sent.promise);
    await show("task-old");
    await press("Pin");
    return () => sent.settle(AsyncResult.success({}));
  },
  Retry: async () => {
    state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("failed")));
    const sent = deferred();
    state.retry.mockReturnValueOnce(sent.promise);
    await show("task-old");
    await press("Retry");
    return () => sent.settle(AsyncResult.success({ status: "started" }));
  },
  "read acknowledgement": async () => {
    // Only the screen it leaves is unread, so the screen it moves to sends no mark of its own.
    state.lookup
      .mockResolvedValueOnce(AsyncResult.success(lookedUp("completed", { unread: true })))
      .mockResolvedValue(AsyncResult.success(lookedUp("completed")));
    const sent = deferred();
    state.update.mockReturnValueOnce(sent.promise);
    state.update.mockResolvedValue(AsyncResult.success({}));
    await show("task-old");
    expect(state.update).toHaveBeenCalled();
    return () => sent.settle(AsyncResult.success({}));
  },
};
const completionCases = (Object.keys(completions) as Array<keyof typeof completions>).flatMap(
  (kind) => (["task", "bot", "computer"] as const).map((change) => ({ kind, change })),
);
it.each(completionCases)(
  "a $kind that completes after a $change change refreshes no list and reads nothing",
  async ({ kind, change }) => {
    const start = completions[kind];
    reset();
    const settle = await start();
    const before = {
      lookups: lookups("env", "main", "task-old"),
      mainRefreshes: refreshes("env", "main"),
    };
    await moveAway(change);
    const after = {
      scout: lookups("env", "scout", "task-old"),
      env2: lookups("env2", "main", "task-old"),
    };
    await act(async () => settle());
    await settleList(
      change === "task" ? "task-b" : "task-old",
      change === "bot" ? scout : undefined,
    );
    expect(refreshes("env", "main")).toBe(before.mainRefreshes);
    expect(refreshes("env", "scout")).toBe(0);
    expect(refreshes("env2", "main")).toBe(0);
    expect(lookups("env", "main", "task-old")).toBe(before.lookups);
    expect(lookups("env", "scout", "task-old")).toBe(after.scout);
    expect(lookups("env2", "main", "task-old")).toBe(after.env2);
  },
);

it("without permission to change task views, Pin and Mark done are shown closed and do nothing", async () => {
  reset();
  state.canUpdate = false;
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await show("task-old");
  for (const label of ["Pin", "Mark done"]) {
    expect(button(label)?.disabled).toBe(true);
    await act(async () => button(label)?.click());
  }
  Object.assign(state.task, { data: { rows: [listRow("task-b", "Task B")] } });
  await show("task-b");
  for (const label of ["Pin", "Mark done"]) expect(button(label)?.disabled).toBe(true);
  expect(state.update).not.toHaveBeenCalled();
});

it("a first list read that fails looks nothing up; once a list settles without the task, it is read once", async () => {
  reset();
  Object.assign(state.task, { data: null, isSuccess: false, error: "failed" });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await show("task-old");
  expect(lookups("env", "main", "task-old")).toBe(0);
  expect(text()).toContain("Couldn't load task. Try again");
  Object.assign(state.task, { data: { rows: [] }, isSuccess: true, error: null });
  await show("task-old");
  expect(lookups("env", "main", "task-old")).toBe(1);
  expect(text()).toContain("Summarize the README");
});

it("a list refresh while the lookup is out starts no second read, and the answer still lands", async () => {
  reset();
  const read = deferred();
  state.lookup.mockReturnValueOnce(read.promise);
  await show("task-old");
  Object.assign(state.task, { isPending: true });
  await show("task-old");
  await settleList("task-old");
  await act(async () => read.settle(AsyncResult.success(lookedUp("completed"))));
  expect(lookups("env", "main", "task-old")).toBe(1);
  expect(button("Pin")).toBeDefined();
});

it("a looked-up task that enters the last successful list shows its row; when it leaves, it is read again once", async () => {
  reset();
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await show("task-old");
  expect(text()).toContain("Summarize the README");
  Object.assign(state.task, { data: { rows: [listRow("task-old", "Summarize the README now")] } });
  await show("task-old");
  expect(text()).toContain("Summarize the README now");
  expect(lookups("env", "main", "task-old")).toBe(1);
  Object.assign(state.task, { data: { rows: [] } });
  await show("task-old");
  expect(lookups("env", "main", "task-old")).toBe(2);
});

it("an action that completes while a reread is out reads the task once more after it", async () => {
  reset();
  const second = deferred();
  state.lookup
    .mockResolvedValueOnce(AsyncResult.success(lookedUp("completed")))
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(AsyncResult.success(lookedUp("completed", { pinnedAt: at })));
  state.update.mockResolvedValue(AsyncResult.success({}));
  await show("task-old");
  await press("Pin");
  await settleList("task-old");
  expect(lookups("env", "main", "task-old")).toBe(2);
  await press("Mark done");
  await settleList("task-old");
  expect(lookups("env", "main", "task-old")).toBe(2);
  await act(async () => second.settle(AsyncResult.success(lookedUp("completed"))));
  expect(lookups("env", "main", "task-old")).toBe(3);
});

it("a bot change starts from a list that has not settled: nothing old is shown and nothing is looked up until it does", async () => {
  reset();
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  await show("task-old");
  expect(button("Pin")).toBeDefined();
  Object.assign(state.task, { data: null, isSuccess: false, isPending: true });
  await show("task-old", scout);
  expect(button("Pin")).toBeUndefined();
  expect(text()).not.toContain("Done");
  expect(lookups("env", "scout", "task-old")).toBe(0);
  Object.assign(state.task, { data: { rows: [] }, isSuccess: true, isPending: false });
  await show("task-old", scout);
  expect(lookups("env", "scout", "task-old")).toBe(1);
});

it("a Pin that completes after the task screen closed refreshes no list and reads nothing", async () => {
  reset();
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed")));
  const sent = deferred();
  state.update.mockReturnValueOnce(sent.promise);
  await show("task-old");
  await press("Pin");
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => sent.settle(AsyncResult.success({})));
  expect(refreshes("env", "main")).toBe(0);
  expect(lookups("env", "main", "task-old")).toBe(1);
});

it("a refresh that returns the task while its lookup is out shows the row, and the late answer is ignored", async () => {
  reset();
  const read = deferred();
  state.lookup.mockReturnValueOnce(read.promise);
  await show("task-old");
  Object.assign(state.task, { isPending: true });
  await show("task-old");
  Object.assign(state.task, {
    isPending: false,
    data: { rows: [listRow("task-old", "Summarize the README now")] },
  });
  await show("task-old");
  expect(text()).toContain("Summarize the README now");
  await act(async () => read.settle(AsyncResult.success(lookedUp("completed", { pinnedAt: at }))));
  expect(text()).toContain("Summarize the README now");
  expect(button("Unpin")).toBeUndefined();
  expect(lookups("env", "main", "task-old")).toBe(1);
});

it("a refresh that fails while the lookup is out leaves the read running, and its answer lands", async () => {
  reset();
  const read = deferred();
  state.lookup.mockReturnValueOnce(read.promise);
  await show("task-old");
  Object.assign(state.task, { isPending: true });
  await show("task-old");
  // The failed refresh keeps the last successful list, as the real query does.
  Object.assign(state.task, { isPending: false, isSuccess: false, error: "failed" });
  await show("task-old");
  await act(async () => read.settle(AsyncResult.success(lookedUp("completed"))));
  expect(button("Pin")).toBeDefined();
  expect(lookups("env", "main", "task-old")).toBe(1);
});

it("a Pin that completes while the next task's lookup is out refreshes nothing and leaves that read alone", async () => {
  reset();
  const pinned = deferred();
  const nextRead = deferred();
  state.lookup
    .mockResolvedValueOnce(AsyncResult.success(lookedUp("completed")))
    .mockReturnValueOnce(nextRead.promise);
  state.update.mockReturnValueOnce(pinned.promise);
  await show("task-old");
  await press("Pin");
  await show("task-b");
  expect(lookups("env", "main", "task-b")).toBe(1);
  const before = refreshes("env", "main");
  await act(async () => pinned.settle(AsyncResult.success({})));
  await settleList("task-b");
  expect(refreshes("env", "main")).toBe(before);
  expect(lookups("env", "main", "task-b")).toBe(1);
  expect(lookups("env", "main", "task-old")).toBe(1);
  await act(async () => nextRead.settle(AsyncResult.success(lookedUp("completed"))));
  expect(button("Pin")).toBeDefined();
});

it.each(["Retry", "read mark"] as const)(
  "a %s that completes after the task screen closed refreshes no list and reads nothing",
  async (kind) => {
    reset();
    const sent = deferred();
    if (kind === "Retry") {
      state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("failed")));
      state.retry.mockReturnValueOnce(sent.promise);
      await show("task-old");
      await press("Retry");
    } else {
      state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed", { unread: true })));
      state.update.mockReturnValueOnce(sent.promise);
      await show("task-old");
      expect(state.update).toHaveBeenCalled();
    }
    await act(async () => root?.unmount());
    root = undefined;
    await act(async () =>
      sent.settle(AsyncResult.success(kind === "Retry" ? { status: "started" } : {})),
    );
    expect(refreshes("env", "main")).toBe(0);
    expect(lookups("env", "main", "task-old")).toBe(1);
  },
);

it("a Pin sent while the task was listed, landing after a refresh dropped it and before any read, leads to one read", async () => {
  reset();
  Object.assign(state.task, { data: { rows: [listRow("task-old", "Summarize the README")] } });
  state.lookup.mockResolvedValue(AsyncResult.success(lookedUp("completed", { pinnedAt: at })));
  const pinned = deferred();
  state.update.mockReturnValueOnce(pinned.promise);
  await show("task-old");
  await press("Pin");
  // A refresh dropped the task, and the list is being read again, so no lookup has started yet.
  Object.assign(state.task, { isPending: true, data: { rows: [] } });
  await show("task-old");
  expect(lookups("env", "main", "task-old")).toBe(0);
  await act(async () => pinned.settle(AsyncResult.success({})));
  expect(lookups("env", "main", "task-old")).toBe(0);
  await settleList("task-old");
  expect(lookups("env", "main", "task-old")).toBe(1);
  expect(button("Unpin")).toBeDefined();
});

it("a Pin sent while the task was listed, landing during the first read after it left, reads once more after it", async () => {
  reset();
  Object.assign(state.task, { data: { rows: [listRow("task-old", "Summarize the README")] } });
  const first = deferred();
  state.lookup
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(AsyncResult.success(lookedUp("completed", { pinnedAt: at })));
  const pinned = deferred();
  state.update.mockReturnValueOnce(pinned.promise);
  await show("task-old");
  await press("Pin");
  Object.assign(state.task, { data: { rows: [] } });
  await show("task-old");
  expect(lookups("env", "main", "task-old")).toBe(1);
  await act(async () => pinned.settle(AsyncResult.success({})));
  await settleList("task-old");
  expect(lookups("env", "main", "task-old")).toBe(1);
  await act(async () => first.settle(AsyncResult.success(lookedUp("completed"))));
  expect(lookups("env", "main", "task-old")).toBe(2);
  expect(button("Unpin")).toBeDefined();
});
