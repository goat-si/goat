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
      accessibilityState?: { selected?: boolean };
    },
  ) => (
    <button
      onClick={props.onPress}
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      aria-pressed={props.accessibilityState?.selected}
    >
      {props.children}
    </button>
  ),
}));
const state = vi.hoisted(() => ({
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
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "openable"
      ? state.remoteOpenable
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
vi.mock("./goatBotHomeMode", () => ({
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

it("returns to a task beyond the finished cutoff even when Show more was already open", async () => {
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
  expect(state.scrolled).toContain(JSON.stringify(["task", "t5"]));
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

it("keeps list-derived work visible after disconnect without reading children", async () => {
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
  ];
  await open();
  await toggleWork("Task one");
  state.childKeys = [];
  state.connected = false;
  await open();
  expect(state.childKeys).toEqual([]);
  expect(home()?.textContent).toContain("Open work thread on mini");
  expect(home()?.textContent).toContain("Open work thread");
});
