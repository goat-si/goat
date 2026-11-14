import { useState } from "react";
import { act, useEffect, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
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
    // Home's shared current work; its links are not read in this file.
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
const coding = (taskId: string, threadId: string, title: string) =>
  decode({
    kind: "coding",
    taskId,
    environmentId: "env",
    threadId,
    title,
    state: "bound",
    lastActivityAt: at,
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

it("shows Work, Routines, then Machines on Home, and files then Memory in Library", async () => {
  state.rows = [task("t1", "Check the disks")];
  await open();
  for (const text of [
    "Machines",
    "bot computer",
    "Work",
    "Check the disks",
    "Routines",
    "Check in on me",
  ])
    expect(container.textContent).toContain(text);
  const content = home()?.textContent ?? "";
  expect(content.indexOf("Work")).toBeLessThan(content.indexOf("Routines"));
  expect(content.indexOf("Routines")).toBeLessThan(content.indexOf("Machines"));
  await press("Library");
  expect(container.textContent).toContain("bot files");
  expect(container.textContent).toContain("Memory");
  await press("Draft a note");
  expect(state.draft).toHaveBeenCalledWith("Remember this");
  expect(button("Library")).toBeUndefined();
});

it("distinguishes offline, unsupported, denied, and failed work reads", async () => {
  state.connected = false;
  await open();
  expect(home()?.textContent).toContain(
    "GOAT Bot's tasks are unavailable while the computer is offline.",
  );
  state.connected = true;
  state.taskSupported = false;
  await open();
  expect(home()?.textContent).toContain("Tasks can't be listed from this server right now.");
  state.taskSupported = true;
  state.taskError = { _tag: "EnvironmentAuthorizationError" };
  await open();
  expect(home()?.textContent).toContain("This device can't read GOAT Bot's work.");
  expect(home()?.textContent).not.toContain("Try again");
  state.taskError = new Error("network");
  await open();
  expect(home()?.textContent).toContain("Couldn't load GOAT Bot's tasks.");
  expect(home()?.textContent).toContain("Try again");
});

it("peeks at a task on Home, opens its thread or its conversation, and comes back to the same Home", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  state.messages = [{ item: { id: "m1", type: "assistant_message", text: "Disk use is 41%." } }];
  await open();
  const scroll = home();
  await press("Check the disks");
  expect(state.openTask).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Disk use is 41%.");
  expect(home()?.getAttribute("aria-hidden")).toBe("true");
  expect(home()?.getAttribute("data-pointer-events")).toBe("none");
  expect(state.childKeys.at(-1)).toEqual({ environmentId: "env", input: { taskIds: ["t1"] } });
  await press("Back to home. Check the disks");
  expect(home()).toBe(scroll);
  expect(home()?.getAttribute("aria-hidden")).toBeNull();
  await press("Check the disks");
  await press("Go to thread");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "worker-1" });
  expect(button("Home")).toBeUndefined();
  await press("Work");
  await press("Check the disks");
  await press("Open task");
  expect(state.openTask).toHaveBeenCalledWith("t1", "Check the disks");
});

it("lists every thread a peeked task started, remote work and subagents included", async () => {
  state.rows = [
    task("t1", "Fix the build", "worker-1"),
    coding("t1", "thread-a", "Patch web"),
    coding("t1", "thread-b", "Patch mobile"),
  ];
  state.remoteWork = [
    {
      childWorkId: "r1",
      taskId: "t1",
      callerThreadId: "bot",
      host: "mac-mini",
      state: "running",
      lastActivityAt: at,
      environmentId: "env-remote",
      threadId: "remote-1",
    },
  ];
  state.groups = [
    {
      taskId: "t1",
      truncated: false,
      children: [
        {
          childWorkId: "c1",
          surface: "delegate_local",
          state: "running",
          destination: { host: "studio" },
        },
      ],
    },
  ];
  await open();
  await press("Fix the build");
  expect(container.textContent).toContain("studio · running");
  await press("Open Patch mobile");
  expect(state.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "thread-b" });
  await press("Work");
  await press("Fix the build");
  await press("Open work thread on mac-mini");
  expect(state.openThread).toHaveBeenLastCalledWith({
    environmentId: "env-remote",
    id: "remote-1",
  });
  await press("Work");
  state.remoteOpenable = false;
  await press("Fix the build");
  expect(container.textContent).toContain("mac-mini · Unavailable");
});

it("peeks at a task with no thread: its state and Open task only", async () => {
  state.rows = [task("t1", "Plan the week")];
  await open();
  await press("Plan the week");
  expect(button("Go to thread")).toBeUndefined();
  await press("Open task");
  expect(state.openTask).toHaveBeenCalledWith("t1", "Plan the week");
});

it("says why a peek has no messages: loading, not connected, deleted, failed or empty", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  const cases: Array<[NonNullable<typeof state.detail>, string]> = [
    [{ status: "synchronizing", data: false, error: null }, "Loading messages…"],
    [{ status: "deleted", data: false, error: null }, "This thread was deleted."],
    [{ status: "live", data: false, error: "boom" }, "Couldn't load this thread's messages."],
    [{ status: "live", data: true, error: null }, "No messages yet."],
  ];
  await open();
  for (const [detail, text] of cases) {
    state.detail = detail;
    await press("Check the disks");
    expect(container.textContent).toContain(text);
    await press("Back to home. Check the disks");
  }
});

it("leaves a peek for an honest unavailable line when the bot's machine disconnects, never a loading one", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  state.detail = { status: "synchronizing", data: false, error: null };
  await open();
  await press("Check the disks");
  expect(container.textContent).toContain("Loading messages…");
  state.connected = false;
  await press("Library");
  await press("Home");
  expect(container.textContent).not.toContain("Loading messages…");
  expect(container.textContent).toContain(
    "GOAT Bot's tasks are unavailable while the computer is offline.",
  );
  expect(home()?.getAttribute("aria-hidden")).toBeNull();
});

it("holds a peeked thread's subscription only while the peek shows, per hook", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1"), task("t2", "Rotate logs", "worker-2")];
  await open();
  expect(state.life).toEqual([]);
  await press("Check the disks");
  expect(state.life.sort()).toEqual(["mount:detail:worker-1", "mount:items:worker-1"]);
  state.life = [];
  await press("Back to home. Check the disks");
  expect(state.life.sort()).toEqual(["cleanup:detail:worker-1", "cleanup:items:worker-1"]);
  state.life = [];
  await press("Rotate logs");
  expect(state.life.sort()).toEqual(["mount:detail:worker-2", "mount:items:worker-2"]);
  state.life = [];
  await press("Close");
  expect(state.life.sort()).toEqual(["cleanup:detail:worker-2", "cleanup:items:worker-2"]);
});

it("keeps the task screen's remote work, subagents and actions", async () => {
  state.rows = [task("t1", "Fix the build", "worker-1")];
  state.remoteWork = [
    {
      childWorkId: "r1",
      taskId: "t1",
      callerThreadId: "bot",
      host: "mac-mini",
      state: "running",
      lastActivityAt: at,
      environmentId: "env-remote",
      threadId: "remote-1",
    },
  ];
  state.groups = [
    {
      taskId: "t1",
      truncated: false,
      children: [
        {
          childWorkId: "c1",
          surface: "delegate_local",
          state: "running",
          destination: { host: "studio" },
        },
      ],
    },
  ];
  await open("t1");
  expect(container.textContent).toContain("studio · running");
  expect(button("Pin")).toBeDefined();
  expect(button("Mark done")).toBeDefined();
  await press("Open work thread on mac-mini");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env-remote", id: "remote-1" });
});

it("closes the peek first on the system back, then the sheet", async () => {
  nativePlatform.OS = "android";
  try {
    state.rows = [task("t1", "Check the disks", "worker-1")];
    await open();
    await press("Check the disks");
    expect(home()?.getAttribute("aria-hidden")).toBe("true");
    await press("System back");
    expect(home()?.getAttribute("aria-hidden")).toBeNull();
    expect(button("Library")).toBeDefined();
    await press("System back");
    expect(button("Library")).toBeUndefined();
  } finally {
    nativePlatform.OS = "ios";
  }
});

it("closes the whole sheet when it is swiped away on iOS, even from a peek", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  await open();
  await press("Check the disks");
  await press("System back");
  expect(button("Library")).toBeUndefined();
});

it("forgets a peeked task that leaves the list, so it does not reopen when it returns", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  await open();
  await press("Check the disks");
  state.rows = [];
  await open();
  expect(home()?.getAttribute("aria-hidden")).toBeNull();
  state.rows = [task("t1", "Check the disks", "worker-1")];
  await open();
  expect(home()?.getAttribute("aria-hidden")).toBeNull();
  expect(button("Back to home. Check the disks")).toBeUndefined();
});

it("opens a thread linked in a peeked message", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  state.messages = [
    { item: { id: "m1", type: "assistant_message", text: "See [it](goat-thread://v1/linked)" } },
  ];
  await open();
  await press("Check the disks");
  await press("Link in: See [it](goat-thread://v1/linked)");
  expect(state.openThread).toHaveBeenCalledWith({ environmentId: "env", id: "linked" });
});

it("reads the machines again when the bot's work changes outside its listed tasks", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  state.workRevision = "task-9:1";
  await open();
  const listed = state.machinesKey;
  // The row list stops at the newest 100 tasks; the conversation's work records cover the rest.
  state.workRevision = "task-9:2";
  await open();
  expect(state.machinesKey).not.toBe(listed);
});

it("keeps a check-in being edited when its entry scrolls away and back", async () => {
  state.rows = [task("t1", "Check the disks", "worker-1")];
  await open();
  await press("Check in on me");
  await press("Check-in time, 09:00");
  await press("Set 07:30");
  expect(button("Check-in time, 07:30")).toBeDefined();
  const routines = ["routines", "routines-label"];
  state.hidden = routines;
  await open();
  expect(button("Check-in time, 07:30")).toBeUndefined();
  state.hidden = [];
  await open();
  expect(button("Check-in time, 07:30")).toBeDefined();
});

function pendingSave() {
  let settle: (result: unknown) => void = () => {};
  state.upsert.mockReset();
  state.upsert.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (result: unknown) => act(async () => settle(result));
}

it("a check-in edited while its save is still running keeps the edit when the save finishes", async () => {
  const settle = pendingSave();
  await open();
  await press("Check in on me");
  await press("Save");
  expect(button("Save")?.disabled).toBe(true);
  // The entry scrolls away and back while the save runs, and the person changes the time.
  state.hidden = ["routines", "routines-label"];
  await open();
  state.hidden = [];
  await open();
  expect(button("Save")?.disabled).toBe(true);
  await press("Check-in time, 09:00");
  await press("Set 07:30");
  await settle(AsyncResult.success({ task: {} }));
  expect(button("Check-in time, 07:30")).toBeDefined();
  expect(button("Save")?.disabled).toBe(false);
});

it("a check-in save that fails after its entry scrolled away shows why when the entry returns", async () => {
  const settle = pendingSave();
  await open();
  await press("Check in on me");
  await press("Save");
  state.hidden = ["routines", "routines-label"];
  await open();
  await settle(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  state.hidden = [];
  await open();
  expect(container.textContent).toContain("Couldn't save the check-in: Denied");
  // Saving again is allowed once the failed save is over.
  expect(button("Save")?.disabled).toBe(false);
});

const checkInRoutine = (timeOfDay: string) => ({
  id: "goat-bot-check-in:bot",
  title: "Check in",
  prompt: "Check in",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay, weekdays: [1, 2, 3, 4, 5] },
  threadId: "bot",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
});

it("a check-in changed while its save runs stays on Home once the routine arrives, and Save updates it", async () => {
  const settle = pendingSave();
  await open();
  await press("Check in on me");
  await press("Save");
  await press("Check-in time, 09:00");
  await press("Set 07:30");
  // The first save lands on the server and the live list brings the routine before the reply.
  state.routineTasks = [checkInRoutine("09:00")];
  await open();
  expect(button("Check-in time, 07:30")).toBeDefined();
  await settle(AsyncResult.success({ task: {} }));
  expect(button("Check-in time, 07:30")).toBeDefined();
  state.upsert.mockReset();
  state.upsert.mockResolvedValue(AsyncResult.success({ task: {} }));
  await press("Save");
  expect(state.upsert).toHaveBeenCalledWith(expect.anything(), {
    environmentId: "env",
    input: expect.objectContaining({
      id: "goat-bot-check-in:bot",
      schedule: expect.objectContaining({ timeOfDay: "07:30" }),
    }),
  });
  // Saved with nothing changed since: the form goes and the routine's own row stays.
  expect(button("Check-in time, 07:30")).toBeUndefined();
});

it("Cancel during a check-in save never lets that save close a newer draft or start a second save", async () => {
  const settle = pendingSave();
  await open();
  await press("Check in on me");
  await press("Sat");
  await press("Save");
  await press("Cancel");
  await press("Check in on me");
  // The first save is still running, so this draft cannot start another.
  expect(button("Save")?.disabled).toBe(true);
  await press("Sun");
  await settle(AsyncResult.success({ task: {} }));
  expect(button("Save")?.disabled).toBe(false);
  expect(button("Sun")?.getAttribute("aria-pressed")).toBe("true");
});

it("keeps a check-in being set up with the bot it was set up for, so another bot's Home starts its own", async () => {
  await open();
  await press("Check in on me");
  await press("Check-in time, 09:00");
  await press("Set 07:30");
  const scout = {
    botId: BotId.make("scout"),
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("scout-thread"),
    name: "Scout",
    defaultModelSelection: null,
  };
  const show = (member: typeof scout | null) =>
    act(async () =>
      root?.render(
        <WorkWithChip
          visible
          member={member}
          onOpenTask={state.openTask}
          onOpenThread={state.openThread}
          onDraft={state.draft}
          workRevision={state.workRevision}
        />,
      ),
    );
  // Scout's Home shows no check-in being set up, and none at 07:30.
  await show(scout);
  expect(button("Check-in time, 07:30")).toBeUndefined();
  expect(button("Check in on me")).toBeDefined();
  // Back on GOAT Bot's Home, its check-in is still at 07:30.
  await show(null);
  expect(button("Check-in time, 07:30")).toBeDefined();
});

it("orders running, waiting, and finished work and collapses finished rows", async () => {
  const row = (id: string, status: string) =>
    decode({
      kind: "task",
      task: { taskId: id, title: id, status, updatedAt: at },
      view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    });
  state.rows = [
    row("waiting", "waiting_input"),
    ...Array.from({ length: 6 }, (_, i) => row(`finished-${i}`, "completed")),
    row("running", "running"),
  ];
  await open();
  const content = home()?.textContent ?? "";
  expect(content.indexOf("running")).toBeLessThan(content.indexOf("waiting"));
  expect(content.indexOf("waiting")).toBeLessThan(content.indexOf("finished-0"));
  expect(button("finished-5")).toBeUndefined();
  await press("Show more");
  expect(button("finished-5")).toBeDefined();
  await press("Show less");
  expect(button("finished-5")).toBeUndefined();
});

it("offers an action button for each task and keeps expansion bounded to 50", async () => {
  state.rows = Array.from({ length: 51 }, (_, i) => task(`t${i}`, `Task ${i}`));
  await open();
  expect(container.querySelectorAll('[aria-label="Actions for Task 0"]')).toHaveLength(1);
  for (let i = 0; i < 51; i++) {
    await press(`Actions for Task ${i}`);
    const choices = nativeAlert.mock.calls.at(-1)?.[2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    expect(choices[0]?.text).toBe("Show work");
    await act(async () => choices[0]?.onPress?.());
  }
  const requests = state.childKeys as Array<{ input: { taskIds: string[] } }>;
  expect(requests.every((request) => request.input.taskIds.length <= 50)).toBe(true);
  expect(requests.at(-1)?.input.taskIds).toEqual(Array.from({ length: 50 }, (_, i) => `t${i + 1}`));
  await press("Actions for Task 0");
  expect(((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>)[0]?.text).toBe(
    "Show work",
  );
  await press("Actions for Task 50");
  expect(((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>)[0]?.text).toBe(
    "Hide work",
  );
});

it("shows the recent-task empty copy", async () => {
  await open();
  expect(home()?.textContent).toContain("No recent tasks");
  expect(home()?.textContent).toContain(
    "Unpinned tasks that finished more than three days ago aren't listed here.",
  );
});

it("offers only expansion without update permission and Mark read only for unread tasks", async () => {
  state.rows = [task("t1", "Read task"), decode({ ...task("t2", "Unread task"), unread: true })];
  state.canUpdate = false;
  await open();
  await press("Actions for Unread task");
  expect(
    ((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>).map(
      (item) => item.text,
    ),
  ).toEqual(["Show work"]);
  state.canUpdate = true;
  await open();
  await press("Actions for Read task");
  expect(
    ((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>).map(
      (item) => item.text,
    ),
  ).toEqual(["Show work", "Pin", "Mark done"]);
  await press("Actions for Unread task");
  expect(
    ((nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{ text: string }>).map(
      (item) => item.text,
    ),
  ).toContain("Mark read");
});

it("labels the static skeleton while the first work read is pending", async () => {
  state.taskPending = true;
  await open();
  expect(container.querySelectorAll('[aria-label="Loading tasks…"]')).toHaveLength(1);
  expect(home()?.textContent).not.toContain("No recent tasks");
});
