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
  AccessibilityInfo: { announceForAccessibility: (text: string) => state.announced.push(text) },
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
    actions: ReadonlyArray<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
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
              disabled: action.attributes?.disabled === true,
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
  paged: true,
  announced: [] as string[],
  // Older-work page reads, answered by each test when it chooses.
  pages: [] as Array<{
    cursor: string | undefined;
    answer: (value: unknown) => Promise<void>;
    fail: () => Promise<void>;
  }>,
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
    listBotThreadsPage: "page",
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
                goatBotTaskThreadsPaged: state.paged,
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
    args[1] === ("page" as never)
      ? new Promise((resolve) => {
          const input = (args[2] as { input: { history?: { cursor?: string } } }).input;
          state.pages.push({
            cursor: input.history?.cursor,
            answer: (value) => act(async () => resolve({ _tag: "Success", value } as never)),
            fail: () => act(async () => resolve({ _tag: "Failure", cause: "down" } as never)),
          });
        })
      : ["readThrough", "pinned", "clientRequestId"].some(
            (key) =>
              (args[2] as { input?: Record<string, unknown> } | undefined)?.input?.[key] !==
              undefined,
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
    paged: true,
    announced: [],
    pages: [],
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

const older = (taskId: string, title: string, unread = false) =>
  decode({
    kind: "task",
    task: { taskId, title, status: "completed", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread,
    mainMessagesSinceQuiet: 0,
  });
const page = (rows: BotThreadRow[], history: Record<string, unknown> = {}) => ({
  rows,
  remoteWork: [],
  mainMessageCount: 0,
  history,
});
const fiveOlder = (first = older("o1", "Old report")) => [
  first,
  older("o2", "Old two"),
  older("o3", "Old three"),
  older("o4", "Old four"),
  older("o5", "Old five"),
];
const reads = () =>
  state.run.mock.calls
    .map((call) => (call as unknown as [unknown, unknown, { input: Record<string, unknown> }])[2])
    .filter((value) => value?.input?.readThrough !== undefined)
    .map((value) => value.input);
const choices = () =>
  (nativeAlert.mock.calls.at(-1)?.[2] ?? []) as Array<{
    text: string;
    disabled: boolean;
    onPress: () => void;
  }>;
async function showOlder(rows = fiveOlder(), history: Record<string, unknown> = {}) {
  await press("Show more");
  await state.pages.at(-1)?.answer(page(rows, history));
}

it("reads older work behind Show more, even when no recent task is listed", async () => {
  await open();
  expect(home()?.textContent).toContain("No recent tasks");
  expect(home()?.textContent).not.toContain("three days");
  await showOlder();
  expect(state.pages[0]?.cursor).toBeUndefined();
  expect(button("Old report")).toBeDefined();
  expect(button("Old five")).toBeDefined();
});

it("keeps today's list and explains the three-day cutoff on a server without paged history", async () => {
  state.paged = false;
  await open();
  expect(home()?.textContent).toContain("Unpinned tasks that finished more than three days ago");
  expect(button("Show more")).toBeUndefined();
});

it("offers Show work, Open and Pin on an older row; Pin sends a pin and Open passes the title", async () => {
  state.rows = [task("now", "Running now")];
  await open();
  await showOlder();
  await press("Actions for Old report");
  expect(choices().map((choice) => [choice.text, choice.disabled])).toEqual([
    ["Show work", false],
    ["Open", false],
    ["Pin", false],
  ]);
  state.run.mockClear();
  await act(async () => choices()[2]?.onPress());
  expect(
    state.run.mock.calls.map(
      (call) => (call as unknown as [unknown, unknown, { input: unknown }])[2].input,
    ),
  ).toEqual([{ taskId: "o1", pinned: true }]);
  await press("Actions for Old report");
  await act(async () => choices()[1]?.onPress());
  expect(state.openTask).toHaveBeenCalledWith("o1", "Old report");
});

it("shows an older row's Pin as unavailable without permission to change task views", async () => {
  state.canUpdate = false;
  await open();
  await showOlder();
  await press("Actions for Old report");
  expect(choices().find((choice) => choice.text === "Pin")?.disabled).toBe(true);
});

it("an older task's peek marks it read and its unread mark goes", async () => {
  resetTaskReadAcknowledgementsForTests();
  state.run.mockClear();
  await open();
  await showOlder(fiveOlder(older("o1", "Old report", true)));
  expect(button("Old report")?.getAttribute("aria-label")).toContain("unread");
  await press("Old report");
  expect(reads()).toEqual([{ taskId: "o1", readThrough: at }]);
  await press("Back to home. Old report");
  expect(button("Old report")?.getAttribute("aria-label")).not.toContain("unread");
});

it("keeps older rows offline with nothing to open, and offers no Show more", async () => {
  await open();
  await showOlder(fiveOlder(), { nextCursor: "c1" });
  state.connected = false;
  await open();
  expect(button("Old report")?.hasAttribute("disabled")).toBe(true);
  expect(button("Show more")).toBeUndefined();
  expect(state.pages).toHaveLength(1);
});

it("says once when older work may be missing, and once when older work could not load", async () => {
  await open();
  await showOlder(fiveOlder(), { nextCursor: "c1", partial: true });
  expect(home()?.textContent).toContain("Older work may be missing");
  expect(state.announced).toEqual(["Older work may be missing."]);
  await open();
  expect(state.announced).toHaveLength(1);
  await press("Show more");
  await state.pages.at(-1)?.fail();
  expect(home()?.textContent).toContain("Couldn't load older work.");
  expect(state.announced).toEqual(["Older work may be missing.", "Couldn't load older work."]);
});

it("keeps the Show more entry in place as Show less once older work ends", async () => {
  state.rows = Array.from({ length: 6 }, (_, index) => older(`f${index}`, `Finished ${index}`));
  await open();
  await showOlder();
  expect(state.pages).toHaveLength(1);
  expect(button("Old report")).toBeDefined();
  expect(button("Show more")).toBeUndefined();
  expect(button("Show less")).toBeDefined();
});

it("says when some of an older task's threads are only in Threads", async () => {
  await open();
  await showOlder(fiveOlder(), { launchesTruncated: ["o1"] });
  expect(home()?.textContent).toContain("Some threads are listed in Threads.");
});

async function openOlderTask(taskId = "o1", taskTitle = "Old report") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <WorkWithChip
        visible
        seen
        taskId={ChannelTaskId.make(taskId)}
        taskTitle={taskTitle}
        onOpenTask={state.openTask}
        onOpenThread={state.openThread}
        onDraft={state.draft}
      />,
    ),
  );
}

it("an older task's screen explains where its actions are, and Open Home opens Home over it", async () => {
  await openOlderTask();
  expect(container.textContent).toContain("Old report");
  expect(container.textContent).toContain(
    "Status and actions for older work are in GOAT Bot's Home.",
  );
  expect(home()).toBeNull();
  await press("Open Home");
  expect(container.querySelectorAll('[data-testid="goat-bot-home-scroll"]')).toHaveLength(1);
  expect(state.openTask).not.toHaveBeenCalled();
  expect(state.openThread).not.toHaveBeenCalled();
  // The chat is not under this Home: nothing here drafts into the task's message box.
  expect(button("New routine")).toBeUndefined();
  await press("Close");
  expect(home()).toBeNull();
  expect(container.textContent).toContain("Status and actions for older work");
});

it("from Home over an older task, the same task only closes Home and another task opens", async () => {
  await openOlderTask();
  await press("Open Home");
  await showOlder();
  await press("Actions for Old report");
  await act(async () => choices()[1]?.onPress());
  expect(state.openTask).not.toHaveBeenCalled();
  expect(home()).toBeNull();
  await press("Open Home");
  await showOlder();
  await press("Actions for Old two");
  await act(async () => choices()[1]?.onPress());
  expect(state.openTask).toHaveBeenCalledWith("o2", "Old two");
});

it("draws no chat chip for Home over an older task on Android", async () => {
  nativePlatform.OS = "android";
  try {
    await openOlderTask();
    await press("Open Home");
    expect(button("GOAT Bot")).toBeUndefined();
  } finally {
    nativePlatform.OS = "ios";
  }
});

it("offline, an older task's Open Home is shown but closed", async () => {
  await openOlderTask();
  state.connected = false;
  await openOlderTask();
  const control = button("Open Home");
  expect(control?.hasAttribute("disabled")).toBe(true);
  expect(control?.getAttribute("aria-disabled")).toBe("true");
});
