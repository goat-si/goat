import { useState } from "react";
import { act, useEffect, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow, ChannelTaskId } from "@goat/contracts";
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
  botRef: { threadId: "bot", environmentId: "env" } as {
    threadId: string;
    environmentId: string;
  } | null,
  otherConnected: false,
  rows2: [] as BotThreadRow[],
  taskKeys: [] as string[],
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
    listBotThreads: (key: { environmentId: string }) => {
      state.taskKeys.push(key.environmentId);
      return key.environmentId === "env2" ? "task2" : "task";
    },
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

      [
        "env2",
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
      key === "task2"
        ? { rows: state.rows2, remoteWork: [] }
        : key === "task"
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
// The real environment selector runs over these computers; "env2" is a second one, connected only
// when a test asks for it.
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    environments: [
      {
        environmentId: "env",
        connected: state.connected,
        supportsChannelLedger: true,
        primary: true,
        label: "jun-mac",
      },
      ...(state.otherConnected
        ? [
            {
              environmentId: "env2",
              connected: true,
              supportsChannelLedger: true,
              primary: false,
              label: "zz-mini",
            },
          ]
        : []),
    ],
    botRef: state.botRef,
  }),
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
    botRef: { threadId: "bot", environmentId: "env" },
    otherConnected: false,
    rows2: [],
    taskKeys: [],
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

async function toggleWork(title: string) {
  await press(`Actions for ${title}`);
  const choices = nativeAlert.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => void }>;
  await act(async () => choices[0]?.onPress?.());
}

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

it("keeps an offline task screen's actions and links listed but inert, until it reconnects", async () => {
  setupReads();
  state.rows = [task("t1", "Fix the build", "worker")];
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
  const pins = () =>
    state.run.mock.calls.filter(
      (call) =>
        (call as unknown as [unknown, unknown, { input: { pinned?: boolean } }])[2]?.input
          ?.pinned !== undefined,
    ).length;
  await open("t1");
  state.connected = false;
  await open("t1");
  for (const label of ["Pin", "Mark done", "Open work thread", "Open work thread on mini"]) {
    const control = button(label);
    expect(control?.hasAttribute("disabled"), label).toBe(true);
    expect(control?.getAttribute("aria-disabled"), label).toBe("true");
    await act(async () => control?.click());
  }
  expect(state.openThread).not.toHaveBeenCalled();
  expect(pins()).toBe(0);
  state.connected = true;
  await open("t1");
  await press("Pin");
  expect(pins()).toBe(1);
  await press("Open work thread");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "worker" });
});

it("keeps a failed task's Retry and its problem on screen offline, closed until it reconnects", async () => {
  setupReads();
  state.retrySupported = true;
  state.rows = [
    decode({
      kind: "task",
      task: { taskId: "t1", title: "Fix the build", status: "failed", updatedAt: at },
      view: { taskId: "t1", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  ];
  const retries = () =>
    state.run.mock.calls.filter(
      (call) =>
        (call as unknown as [unknown, unknown, { input: { clientRequestId?: string } }])[2]?.input
          ?.clientRequestId !== undefined,
    ).length;
  await open("t1");
  state.run.mockResolvedValueOnce({
    _tag: "Success",
    value: { status: "refused", reason: "elsewhere" },
  } as never);
  await press("Retry");
  const problem = "This ran on another computer. Check it there, then ask again in chat.";
  expect(container.textContent).toContain(problem);
  state.connected = false;
  await open("t1");
  const retry = button("Retry");
  expect(retry?.hasAttribute("disabled")).toBe(true);
  expect(retry?.getAttribute("aria-disabled")).toBe("true");
  expect(container.textContent).toContain(problem);
  await act(async () => retry?.click());
  expect(retries()).toBe(1);
  state.connected = true;
  await open("t1");
  state.run.mockResolvedValueOnce({
    _tag: "Success",
    value: { status: "started", taskId: "t1", generation: 2 },
  } as never);
  await press("Retry");
  expect(retries()).toBe(2);
});

it("keeps an offline task screen's child-only work readable from the last read, without reading again", async () => {
  state.rows = [task("t1", "Fix the build")];
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
        {
          childWorkId: "c2",
          surface: "delegate_local",
          state: "running",
          destination: { host: "studio" },
        },
      ],
    },
  ];
  await open("t1");
  expect(container.textContent).toContain("studio · running");
  const childReads = state.childKeys.length;
  state.connected = false;
  await open("t1");
  expect(state.childKeys).toHaveLength(childReads);
  expect(container.textContent).toContain("studio · running");
  const link = button("Open work thread");
  expect(link?.hasAttribute("disabled")).toBe(true);
  expect(link?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => link?.click());
  expect(state.openThread).not.toHaveBeenCalled();
  state.connected = true;
  await open("t1");
  expect(state.childKeys.length).toBeGreaterThan(childReads);
  await press("Open work thread");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "child-thread" });
});

it("does not mark an offline task screen read, and does once it reconnects", async () => {
  setupReads();
  state.rows = [unreadTask("t1", "Check the disks")];
  state.seen = false;
  await open("t1");
  state.connected = false;
  state.seen = true;
  await open("t1");
  expect(reads()).toEqual([]);
  state.connected = true;
  await open("t1");
  expect(reads()).toEqual([{ taskId: "t1", readThrough: at }]);
});

it("keeps Home's expanded child-only work readable offline, with its links closed", async () => {
  state.rows = [task("t1", "Fix the build")];
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
  await toggleWork("Fix the build");
  state.connected = false;
  await open();
  expect(home()?.textContent).toContain("studio · running");
  expect(home()?.textContent).not.toContain("No other work.");
  expect(home()?.textContent).not.toContain("Loading work…");
  expect(home()?.textContent).not.toContain("Couldn't load subagents.");
  const link = button("Open work thread");
  expect(link?.hasAttribute("disabled")).toBe(true);
  await act(async () => link?.click());
  expect(state.openThread).not.toHaveBeenCalled();
});

it("offline, an expanded task's thread and remote links stay listed but do not open", async () => {
  state.rows = [
    task("t1", "Fix the build", "worker"),
    decode({
      kind: "coding",
      taskId: "t1",
      environmentId: "env",
      threadId: "thread-a",
      title: "Patch web",
      state: "bound",
      lastActivityAt: at,
    }),
  ];
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
  await toggleWork("Fix the build");
  await press("GOAT thread: Patch web");
  expect(state.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "thread-a" });
  state.openThread.mockClear();
  state.connected = false;
  await open();
  for (const label of ["GOAT thread: Patch web", "Open work thread on mini"]) {
    const link = button(label);
    expect(link?.hasAttribute("disabled"), label).toBe(true);
    expect(link?.getAttribute("aria-disabled"), label).toBe("true");
    await act(async () => link?.click());
  }
  expect(state.openThread).not.toHaveBeenCalled();
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

it("keeps an offline task listed, but it neither opens nor offers task actions", async () => {
  setupReads();
  state.rows = [unreadTask("t1", "Check the disks")];
  await open();
  await press("Check the disks");
  expect(button("Back to home. Check the disks")).toBeDefined();
  const sent = reads().length;
  // The list was read while connected; the computer then goes offline with the peek open.
  state.connected = false;
  await open();
  expect(button("Back to home. Check the disks")).toBeUndefined();
  expect(button("Check the disks")?.hasAttribute("disabled")).toBe(true);
  await press("Actions for Check the disks");
  expect(
    ((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>).map(
      (item) => item.text,
    ),
  ).toEqual(["Show work"]);
  expect(reads()).toHaveLength(sent);
});

it("with no bot computer saved, keeps nothing once that computer disconnects and none is connected", async () => {
  state.botRef = null;
  state.rows = [task("t1", "Fix the build")];
  await open();
  expect(button("Fix the build")).toBeDefined();
  const listReads = state.taskKeys.length;
  state.connected = false;
  await open();
  // Home follows the selector, as on dev: no computer is selected, so nothing is kept or read.
  expect(home()?.textContent).toContain(
    "GOAT Bot's tasks are unavailable while the computer is offline.",
  );
  expect(button("Fix the build")).toBeUndefined();
  expect(state.taskKeys).toHaveLength(listReads);
  state.connected = true;
  await open();
  expect(state.taskKeys.length).toBeGreaterThan(listReads);
  expect(button("Fix the build")?.hasAttribute("disabled")).toBe(false);
});

it("with no bot computer saved, follows another connected computer and shows only its work", async () => {
  state.botRef = null;
  state.otherConnected = true;
  state.rows = [task("t1", "Fix the build")];
  state.rows2 = [task("t2", "Patch the mini")];
  await open();
  expect(button("Fix the build")).toBeDefined();
  state.connected = false;
  await open();
  expect(state.taskKeys.at(-1)).toBe("env2");
  expect(button("Patch the mini")?.hasAttribute("disabled")).toBe(false);
  expect(button("Fix the build")).toBeUndefined();
});
