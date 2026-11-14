import { useState } from "react";
import { act, useEffect, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Props = Record<string, unknown> & { children?: ReactNode };
const forward = (props: Props) => ({
  "data-testid": props.testID as string | undefined,
  "data-pointer-events": props.pointerEvents as string | undefined,
  "aria-label": props.accessibilityLabel as string | undefined,
  "aria-hidden": props.accessibilityElementsHidden === true ? true : undefined,
});
const nativeAlert = vi.hoisted(() => vi.fn());
const nativePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  Platform: nativePlatform,
  Switch: () => null,
  View: (props: Props) => <div {...forward(props)}>{props.children}</div>,
  ScrollView: (props: Props) => <div {...forward(props)}>{props.children}</div>,
  FlatList: function FlatList(
    props: {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
      ref?: Ref<{ scrollToIndex: (value: { index: number }) => void }>;
      onScrollToIndexFailed?: (info: { index: number; averageItemLength: number }) => void;
      onContentSizeChange?: () => void;
    } & Record<string, unknown>,
  ) {
    useImperativeHandle(props.ref, () => ({
      scrollToIndex: ({ index }) => {
        state.scrolled.push(props.data[index]?.key ?? "missing");
        if (state.failScroll) props.onScrollToIndexFailed?.({ index, averageItemLength: 40 });
      },
      scrollToOffset: () => {},
    }));
    state.contentChanged = props.onContentSizeChange ?? (() => {});
    return (
      <div {...forward(props as Props)}>
        {/* Entries listed in state.hidden are off screen: a virtualized list unmounts them. */}
        {props.data.map((item, index) =>
          state.hidden.includes(item.key) ? null : (
            <div key={item.key}>{props.renderItem({ item, index })}</div>
          ),
        )}
      </div>
    );
  },
  // Android's system back and an iOS swipe-down both reach the sheet as onRequestClose.
  Modal: (props: Props & { visible: boolean; onRequestClose?: () => void }) =>
    props.visible ? (
      <div>
        <button aria-label="System back" onClick={props.onRequestClose} />
        {props.children}
      </div>
    ) : null,
  Alert: { alert: nativeAlert },
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (
    props: Props & {
      onPress?: () => void;
      accessibilityLabel?: string;
      disabled?: boolean;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
    },
  ) => (
    <button
      onClick={props.onPress}
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      aria-disabled={props.accessibilityState?.disabled}
      aria-pressed={props.accessibilityState?.selected}
    >
      {props.children}
    </button>
  ),
}));
// The row menu is native; this stands in for it and hands its choices to the Alert mock.
vi.mock("./MobileBotRowMenu", () => ({
  MobileBotRowMenu: (props: {
    label: string;
    title: string;
    actions: ReadonlyArray<{ id: string; title: string }>;
    onSelect: (id: string) => void;
    row?: ReactNode;
  }) => (
    <>
      {props.row}
      <button
        aria-label={props.label}
        onClick={() =>
          nativeAlert(
            props.title,
            undefined,
            props.actions.map((action) => ({
              text: action.title,
              onPress: () => props.onSelect(action.id),
            })),
          )
        }
      />
    </>
  ),
}));
const state = vi.hoisted(() => ({
  // Whether the screen is focused and the app active; a task is marked read only then.
  seen: true,
  run: vi.fn(async () => ({ _tag: "Success" as string })),
  rows: [] as BotThreadRow[],
  remoteWork: [] as object[],
  groups: [] as object[],
  childKeys: [] as unknown[],
  childError: null as string | null,
  childPending: false,
  childRefresh: vi.fn(),
  scrolled: [] as string[],
  failScroll: false,
  contentChanged: () => {},
  remoteOpenable: true,
  connected: true,
  retrySupported: false,
  taskSupported: true,
  childSupported: true,
  membersSupported: true,
  taskError: null as unknown,
  taskPending: false,
  canUpdate: true,
  detail: null as null | { status: string; data: boolean; error: string | null },
  messages: [] as object[],
  life: [] as string[],
  draft: vi.fn(() => true),
  openTask: vi.fn(),
  openThread: vi.fn(),
  workRevision: null as string | null,
  hidden: [] as string[],
  machinesKey: undefined as string | undefined,
  // The check-in save the form starts; a test settles it when it chooses.
  upsert: vi.fn<() => Promise<unknown>>(),
  // The live routines list; a saved check-in arrives here.
  routineTasks: [] as object[],
  // Home's shared current work, the value that also hides those threads from Threads.
  current: null as null | { eligible: boolean; list: string; work: object; links: object[] },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "openable"
      ? state.remoteOpenable
      : atom === "home-current"
        ? state.current
        : atom === "update-permission"
          ? state.canUpdate
          : true,
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (props: {
    options: { unstable_headerRightItems: () => { label: string; onPress: () => void }[] };
  }) =>
    props.options.unstable_headerRightItems().map((item) => (
      <button key={item.label} onClick={item.onPress}>
        {item.label}
      </button>
    )),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    // Home's shared current work; tests that need its links set state.current.
    homeCurrentOpenableWorkAtom: () => "home-current",
    listBotThreads: () => "task",
    listChildWork: (key: unknown) => {
      state.childKeys.push(key);
      return "child";
    },
    remoteWorkOpenable: () => "openable",
    updateTaskView: { permissionAtom: () => "update-permission" },
    retryTask: { label: "retry", permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => "routines",
    upsertScheduledTask: { label: "upsert", permissionAtom: () => "permission", run: state.upsert },
    setScheduledTaskEnabled: { permissionAtom: () => "permission" },
    runScheduledTaskNow: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ id: "bot", projectId: "bot-project", modelSelection: null }),
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: (props: { onValueChange: (event: unknown, date: Date) => void }) => (
    <button onClick={() => props.onValueChange(undefined, new Date(2026, 10, 11, 7, 30))}>
      Set 07:30
    </button>
  ),
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
                goatBotTaskThreads: state.taskSupported,
                goatBotChildWork: state.childSupported,
                goatBotMembers: state.membersSupported,
                goatBotTaskRetry: state.retrySupported,
              },
            },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) => ({
    data:
      key === "task"
        ? state.taskPending
          ? null
          : { rows: state.rows, remoteWork: state.remoteWork }
        : key === "child"
          ? state.childPending || state.childError
            ? null
            : { groups: state.groups }
          : key === "routines"
            ? { tasks: state.routineTasks }
            : null,
    error: key === "task" ? state.taskError : key === "child" ? state.childError : null,
    cause: key === "task" ? state.taskError : null,
    isPending: key === "child" && state.childPending,
    isSuccess: key !== null,
    refresh: key === "child" ? state.childRefresh : vi.fn(),
  }),
}));
// Stands in for the thread-state subscription useAtomValue holds while a consumer is mounted.
function useSubscription(name: string, target: { threadId: string | null }) {
  useEffect(() => {
    if (target.threadId === null) return;
    state.life.push(`mount:${name}:${target.threadId}`);
    return () => {
      state.life.push(`cleanup:${name}:${target.threadId}`);
    };
  }, [name, target.threadId]);
}
vi.mock("../../state/use-thread-detail", () => ({
  useThreadDetail: (target: { threadId: string | null }) => {
    useSubscription("detail", target);
    const detail = state.detail ?? { status: "live", data: true, error: null };
    return {
      status: detail.status,
      data: detail.data ? Option.some({}) : Option.none(),
      error: detail.error === null ? Option.none() : Option.some(detail.error),
    };
  },
  useThreadVisibleTurnItems: (target: { threadId: string | null }) => {
    useSubscription("items", target);
    return state.messages;
  },
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("./GoatBotFace", () => ({ GoatBotFaceAvatar: () => null }));
vi.mock("./GoatBotTaskRow", () => ({ GoatBotTaskRow: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => <p>status card</p> }));
vi.mock("./MobileBotComputer", () => ({
  MobileBotComputer: (props: { workKey?: string }) => {
    state.machinesKey = props.workKey;
    return <p>bot computer</p>;
  },
}));
vi.mock("./MobileBotLibrary", () => ({ MobileBotLibrary: () => <p>bot files</p> }));
vi.mock("./MobileBotMemory", () => ({
  MobileBotMemory: (props: { onDraft?: (text: string) => void }) => (
    <button onClick={() => props.onDraft?.("Remember this")}>Draft a note</button>
  ),
}));
vi.mock("./goatBotHomeMode", async (original) => ({
  ...(await original<typeof import("./goatBotHomeMode")>()),
  pickMobileGoatBotEnvironment: () => ({
    environmentId: "env",
    connected: state.connected,
    label: "jun-mac",
  }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotMarkdown", () => ({
  GoatBotMarkdown: (props: {
    text: string;
    environmentId: string | null;
    onSelectThread: (thread: { environmentId: string; id: string }) => void;
  }) => (
    <button
      aria-label={`Link in: ${props.text}`}
      onClick={() => props.onSelectThread({ environmentId: "env", id: "linked" })}
    >
      {props.text}
    </button>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
// Read acknowledgements and pin changes go to state.run so a test sees what the server would
// receive; every other command runs as before.
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  const runAtomCommand = ((...args: Parameters<typeof real.runAtomCommand>) =>
    ["readThrough", "pinned", "clientRequestId"].some(
      (key) =>
        (args[2] as { input?: Record<string, unknown> } | undefined)?.input?.[key] !== undefined,
    )
      ? state.run(...(args as unknown as []))
      : real.runAtomCommand(...args)) as typeof real.runAtomCommand;
  return { ...real, runAtomCommand };
});
import { resetTaskReadAcknowledgementsForTests } from "@goat/client-runtime/goatBot";
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

const at = "2026-11-11T02:00:00.000Z";
const decode = Schema.decodeUnknownSync(BotThreadRow);
const task = (taskId: string, title: string, worker?: string) =>
  decode({
    kind: "task",
    task: { taskId, title, status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    ...(worker ? { worker: { environmentId: "env", threadId: worker } } : {}),
  });

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  Object.assign(state, {
    rows: [],
    remoteWork: [],
    groups: [],
    childKeys: [],
    childError: null,
    childPending: false,
    scrolled: [],
    failScroll: false,
    remoteOpenable: true,
    connected: true,
    taskSupported: true,
    childSupported: true,
    membersSupported: true,
    retrySupported: false,
    taskError: null,
    taskPending: false,
    canUpdate: true,
    detail: null,
    messages: [],
    life: [],
    workRevision: null,
    hidden: [],
    machinesKey: undefined,
    routineTasks: [],
    current: null,
  });
  state.draft.mockClear();
  state.openTask.mockClear();
  state.openThread.mockClear();
  state.childRefresh.mockClear();
});
async function open(taskId?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        seen={state.seen}
        taskId={taskId === undefined ? undefined : ChannelTaskId.make(taskId)}
        onOpenTask={state.openTask}
        onOpenThread={state.openThread}
        onDraft={state.draft}
        workRevision={state.workRevision}
      />,
    ),
  );
  if (taskId === undefined) await press("Work");
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (item) =>
      item.textContent === label ||
      item.getAttribute("aria-label") === label ||
      // A task row reads "<title>, <status>…".
      item.getAttribute("aria-label")?.startsWith(`${label}, `) === true,
  );
async function press(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target?.click());
}
const home = () => container.querySelector('[data-testid="goat-bot-home-scroll"]');

it("loads expanded work from the shared child read and opens a child-only thread", async () => {
  state.rows = [task("t1", "Task one")];
  state.groups = [
    {
      taskId: "t1",
      truncated: true,
      children: [
        {
          childWorkId: "c1",
          surface: "thread_launch",
          state: "running",
          destination: { threadId: "child-thread" },
        },
        {
          childWorkId: "c2",
          surface: "delegate_local",
          state: "running",
          destination: { host: "studio" },
        },
      ],
    },
  ];
  await open();
  expect(state.childKeys).toHaveLength(0);
  await press("Actions for Task one");
  const choices = nativeAlert.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => void }>;
  await act(async () => choices[0]?.onPress?.());
  expect(state.childKeys.at(-1)).toEqual({ environmentId: "env", input: { taskIds: ["t1"] } });
  expect(home()?.textContent).toContain("studio · running");
  expect(home()?.textContent).toContain("More work is available.");
  await press("Open work thread");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "child-thread" });
});

it("says an expanded task has no other work only after a complete read found none", async () => {
  state.rows = [task("t1", "Fix the build")];
  state.groups = [{ taskId: "t1", truncated: false, children: [] }];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).toContain("No other work.");
});

it("does not call a task's work empty when the read left that task out", async () => {
  state.rows = [task("t1", "Fix the build")];
  // The server omits a task it no longer owns instead of sending an empty group.
  state.groups = [{ taskId: "t2", truncated: false, children: [] }];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).not.toContain("No other work.");
});

it("does not call a task's work empty while its only child has no thread to show yet", async () => {
  state.rows = [task("t1", "Fix the build")];
  state.groups = [
    {
      taskId: "t1",
      truncated: false,
      children: [{ childWorkId: "c1", surface: "thread_launch", state: "running" }],
    },
  ];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).not.toContain("No other work.");
});

it("does not call a task's work empty when this server cannot read sub-work", async () => {
  state.childSupported = false;
  state.rows = [task("t1", "Fix the build")];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).not.toContain("No other work.");
});

it("names each coding thread of an expanded task, so two threads can be told apart", async () => {
  const coding = (threadId: string, title: string) =>
    decode({
      kind: "coding",
      taskId: "t1",
      environmentId: "env",
      threadId,
      title,
      state: "bound",
      lastActivityAt: at,
    });
  state.rows = [
    task("t1", "Fix the build"),
    coding("thread-a", "Patch web"),
    coding("thread-b", "Patch mobile"),
  ];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).toContain("Patch web");
  expect(home()?.textContent).toContain("Patch mobile");
  await press("GOAT thread: Patch mobile");
  expect(state.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "thread-b" });
});

it("returns from a hidden finished task by revealing and scrolling to its row", async () => {
  state.rows = Array.from({ length: 6 }, (_, i) =>
    decode({
      kind: "task",
      task: { taskId: `t${i}`, title: `Task ${i}`, status: "completed", updatedAt: at },
      view: { taskId: `t${i}`, pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  );
  await open();
  await press("Show more");
  await press("Task 5");
  await press("Show less");
  await press("Back to home. Task 5");
  expect(button("Task 5")).toBeDefined();
  expect(state.scrolled).toContain(JSON.stringify(["task", "t5"]));
});

it("leaves Home where it was on Back when Show more was already open for the row", async () => {
  state.rows = Array.from({ length: 6 }, (_, i) =>
    decode({
      kind: "task",
      task: { taskId: `t${i}`, title: `Task ${i}`, status: "completed", updatedAt: at },
      view: { taskId: `t${i}`, pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  );
  await open();
  await press("Show more");
  await press("Task 5");
  await press("Back to home. Task 5");
  expect(state.scrolled).toEqual([]);
  expect(button("Task 5")).toBeDefined();
});

it("does not scroll when returning from a visible row, including Android back", async () => {
  nativePlatform.OS = "android";
  try {
    state.rows = [task("t1", "Task one")];
    await open();
    await press("Task one");
    await press("System back");
    expect(state.scrolled).toEqual([]);
  } finally {
    nativePlatform.OS = "ios";
  }
});

it("drops a retry when the returned task leaves the list", async () => {
  state.rows = Array.from({ length: 6 }, (_, i) =>
    decode({
      kind: "task",
      task: { taskId: `t${i}`, title: `Task ${i}`, status: "completed", updatedAt: at },
      view: { taskId: `t${i}`, pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  );
  nativePlatform.OS = "android";
  try {
    await open();
    await press("Show more");
    await press("Task 5");
    await press("Show less");
    state.failScroll = true;
    await press("System back");
    expect(state.scrolled).toEqual([JSON.stringify(["task", "t5"])]);
    state.rows = state.rows.slice(0, 5);
    await open();
    await act(async () => state.contentChanged());
    expect(state.scrolled).toHaveLength(1);
  } finally {
    nativePlatform.OS = "ios";
  }
});

it("a routine landing replaces a pending peek return", async () => {
  state.rows = Array.from({ length: 6 }, (_, i) =>
    decode({
      kind: "task",
      task: { taskId: `t${i}`, title: `Task ${i}`, status: "completed", updatedAt: at },
      view: { taskId: `t${i}`, pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  );
  await open();
  await press("Show more");
  await press("Task 5");
  await press("Show less");
  state.failScroll = true;
  await press("Back to home. Task 5");
  state.failScroll = false;
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        focus={{ kind: "routine", id: "routine-1", seq: 1 }}
        onOpenTask={state.openTask}
        onOpenThread={state.openThread}
        onDraft={state.draft}
        workRevision={state.workRevision}
      />,
    ),
  );
  state.scrolled = [];
  await act(async () => state.contentChanged());
  expect(state.scrolled).not.toContain(JSON.stringify(["task", "t5"]));
});

it("shows unsupported work for a member without the members capability", async () => {
  state.membersSupported = false;
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        member={{
          botId: BotId.make("scout"),
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("scout-thread"),
          name: "Scout",
          defaultModelSelection: null,
        }}
        onOpenTask={state.openTask}
        onOpenThread={state.openThread}
      />,
    ),
  );
  await press("Work");
  expect(home()?.textContent).toContain("Tasks can't be listed from this server right now.");
});

async function toggleWork(title: string) {
  await press(`Actions for ${title}`);
  const choices = nativeAlert.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => void }>;
  await act(async () => choices[0]?.onPress?.());
}

it("shows loading and failure for expanded work, with no Try again that could not read again", async () => {
  state.rows = [task("t1", "Task one")];
  state.childPending = true;
  await open();
  await toggleWork("Task one");
  expect(home()?.textContent).toContain("Loading work…");
  state.childPending = false;
  state.childError = "failed";
  await open();
  expect(home()?.textContent).toContain("Couldn't load subagents.");
  expect(home()?.textContent).not.toContain("Try again");
});

it("retains list work without a child capability and reads again after collapse and expansion", async () => {
  state.rows = [task("t1", "Task one", "worker")];
  state.remoteWork = [
    {
      childWorkId: "r1",
      taskId: "t1",
      callerThreadId: "bot",
      host: "mini",
      state: "running",
      lastActivityAt: at,
      environmentId: "remote",
      threadId: "remote-thread",
    },
    {
      childWorkId: "r2",
      taskId: "t1",
      callerThreadId: "bot",
      host: "other",
      state: "running",
      lastActivityAt: at,
    },
  ];
  state.childSupported = false;
  await open();
  await toggleWork("Task one");
  expect(state.childKeys).toHaveLength(0);
  expect(home()?.textContent).toContain("Open work thread on mini");
  expect(home()?.textContent).toContain("other · Unavailable");
  state.childSupported = true;
  await open();
  expect(state.childKeys.at(-1)).toEqual({ environmentId: "env", input: { taskIds: ["t1"] } });
  await toggleWork("Task one");
  state.childKeys = [];
  await toggleWork("Task one");
  expect(state.childKeys.at(-1)).toEqual({ environmentId: "env", input: { taskIds: ["t1"] } });
});

const unreadTask = (taskId: string, title: string) =>
  decode({
    kind: "task",
    task: { taskId, title, status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: true,
    mainMessagesSinceQuiet: 0,
  });
// The read requests sent to the server, as the input each one carried.
const reads = () =>
  state.run.mock.calls
    .map((call) => (call as unknown as [unknown, unknown, { input: { readThrough?: string } }])[2])
    .filter((value) => value?.input?.readThrough !== undefined)
    .map((value) => value.input);
function setupReads(result: { _tag: string } = { _tag: "Success" }) {
  resetTaskReadAcknowledgementsForTests();
  state.run.mockReset();
  state.run.mockResolvedValue(result);
  state.seen = true;
  nativeAlert.mockClear();
}

it("a peek marks its unread task read once, and not again when reopened with no newer activity", async () => {
  setupReads();
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  expect(reads()).toEqual([]);
  await press("Check the disks");
  expect(reads()).toEqual([{ taskId: "t1", readThrough: at }]);
  await open();
  await press("Back to home. Check the disks");
  await press("Check the disks");
  expect(reads()).toHaveLength(1);
  state.seen = true;
});

it("a peek on a phone that is not looking (backgrounded or inactive) marks nothing until it is", async () => {
  setupReads();
  state.seen = false;
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  await press("Check the disks");
  expect(reads()).toEqual([]);
  state.seen = true;
  await open();
  expect(reads()).toEqual([{ taskId: "t1", readThrough: at }]);
});

it("a failed peek read stays quiet and is sent again only when the task is shown again", async () => {
  setupReads({ _tag: "Failure" });
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  await press("Check the disks");
  expect(reads()).toHaveLength(1);
  expect(nativeAlert).not.toHaveBeenCalledWith("Could not mark task read", expect.anything());
  await open();
  expect(reads()).toHaveLength(1);
  await press("Back to home. Check the disks");
  await press("Check the disks");
  expect(reads()).toHaveLength(2);
});

it("marks nothing read without permission to update tasks", async () => {
  setupReads();
  state.canUpdate = false;
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  await press("Check the disks");
  expect(reads()).toEqual([]);
});

it("the task's own screen marks it read once while seen, and says so when that fails", async () => {
  setupReads({ _tag: "Failure" });
  state.seen = false;
  state.rows = [unreadTask("t1", "Check the disks")];
  await open("t1");
  expect(reads()).toEqual([]);
  state.seen = true;
  await open("t1");
  expect(reads()).toEqual([{ taskId: "t1", readThrough: at }]);
  expect(nativeAlert).toHaveBeenCalledWith("Could not mark task read", "Please try again.");
  await open("t1");
  expect(reads()).toHaveLength(1);
});

it("marks a shown task read again when newer activity arrives, on its screen and in a peek", async () => {
  setupReads();
  const later = "2026-11-11T03:00:00.000Z";
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  await press("Check the disks");
  expect(reads()).toEqual([{ taskId: "t1", readThrough: at }]);
  state.rows = [decode({ ...unreadTask("t1", "Check the disks"), lastActivityAt: later })];
  await open();
  expect(reads()).toEqual([
    { taskId: "t1", readThrough: at },
    { taskId: "t1", readThrough: later },
  ]);
  // The task's own screen, mounted fresh with no sheet or peek, reads newer activity once while
  // it stays open.
  await act(async () => root?.unmount());
  root = undefined;
  await open("t1");
  expect(reads()).toHaveLength(2);
  const evenLater = "2026-11-11T04:00:00.000Z";
  state.rows = [decode({ ...unreadTask("t1", "Check the disks"), lastActivityAt: evenLater })];
  await open("t1");
  expect(reads()).toEqual([
    { taskId: "t1", readThrough: at },
    { taskId: "t1", readThrough: later },
    { taskId: "t1", readThrough: evenLater },
  ]);
  await open("t1");
  expect(reads()).toHaveLength(3);
});

const codingRow = (threadId: string, title: string) =>
  decode({
    kind: "coding",
    taskId: "t1",
    environmentId: "env",
    threadId,
    title,
    state: "bound",
    lastActivityAt: at,
  });
const governed = (links: object[], taskIds = ["t1"]) => ({
  eligible: true,
  list: "ready",
  work: {
    running: taskIds.map((id) => ({ row: { task: { taskId: id } } })),
    waiting: [],
    finished: [],
  },
  links,
});

it("a current task's work opens what Home's shared value links, and a child-only thread after it", async () => {
  state.rows = [
    task("t1", "Fix the build"),
    codingRow("thread-a", "Patch web"),
    codingRow("thread-b", "Patch mobile"),
  ];
  state.groups = [
    {
      taskId: "t1",
      truncated: false,
      children: [
        {
          childWorkId: "c1",
          surface: "thread_launch",
          state: "running",
          destination: { threadId: "child-thread" },
        },
      ],
    },
  ];
  // thread-b's machine cannot be reached, so the shared value has no link for it.
  state.current = governed([
    { taskId: "t1", environmentId: "env", threadId: "thread-a", kind: "coding" },
  ]);
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).toContain("Patch web");
  expect(home()?.textContent).not.toContain("Patch mobile");
  // The child-only thread is listed after the linked one, and opens its own thread.
  const labels = [...container.querySelectorAll("button")].map((item) =>
    item.getAttribute("aria-label"),
  );
  expect(labels.indexOf("GOAT thread: Patch web")).toBeGreaterThanOrEqual(0);
  expect(labels.indexOf("Work thread: Fix the build")).toBeGreaterThan(
    labels.indexOf("GOAT thread: Patch web"),
  );
  await press("Work thread: Fix the build");
  expect(state.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "child-thread" });
  // Opening a thread closes Home; reopened, the task's work is still shown.
  await open();
  await press("GOAT thread: Patch web");
  expect(state.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "thread-a" });
});

it("an untitled coding thread reads Open work thread, as on web", async () => {
  state.rows = [task("t1", "Fix the build"), codingRow("thread-a", "   ")];
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).toContain("Open work thread");
  expect(home()?.textContent).not.toContain("GOAT thread");
});

it("a current task's remote work opens only when Home's shared value links it", async () => {
  state.rows = [task("t1", "Fix the build")];
  state.remoteWork = [
    {
      childWorkId: "r1",
      taskId: "t1",
      callerThreadId: "bot",
      host: "studio",
      environmentId: "remote",
      threadId: "remote-thread",
      workKind: "coding",
      state: "running",
    },
  ];
  state.current = governed([]);
  await open();
  await toggleWork("Fix the build");
  expect(home()?.textContent).toContain("studio · Unavailable");
  state.current = governed([
    {
      taskId: "t1",
      environmentId: "remote",
      threadId: "remote-thread",
      kind: "remote",
      remoteChildWorkId: "r1",
      launchedFrom: { environmentId: "env", threadId: "bot" },
    },
  ]);
  await open();
  await press("Open work thread on studio");
  expect(state.openThread).toHaveBeenLastCalledWith({
    environmentId: "remote",
    id: "remote-thread",
  });
});
