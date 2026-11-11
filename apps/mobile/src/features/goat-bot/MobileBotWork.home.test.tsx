import { useState } from "react";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Props = Record<string, unknown> & { children?: ReactNode };
const forward = (props: Props) => ({
  "data-testid": props.testID as string | undefined,
  "data-pointer-events": props.pointerEvents as string | undefined,
  "aria-hidden": props.accessibilityElementsHidden === true ? true : undefined,
});
const nativePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
vi.mock("react-native", () => ({
  Platform: nativePlatform,
  Switch: () => null,
  View: (props: Props) => <div {...forward(props)}>{props.children}</div>,
  ScrollView: (props: Props) => <div {...forward(props)}>{props.children}</div>,
  FlatList: (
    props: {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    } & Record<string, unknown>,
  ) => (
    <div {...forward(props as Props)}>
      {props.data.map((item, index) => (
        <div key={item.key}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
  // Android's system back and an iOS swipe-down both reach the sheet as onRequestClose.
  Modal: (props: Props & { visible: boolean; onRequestClose?: () => void }) =>
    props.visible ? (
      <div>
        <button aria-label="System back" onClick={props.onRequestClose} />
        {props.children}
      </div>
    ) : null,
  Alert: { alert: vi.fn() },
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (
    props: Props & { onPress?: () => void; accessibilityLabel?: string; disabled?: boolean },
  ) => (
    <button onClick={props.onPress} aria-label={props.accessibilityLabel} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));
const state = vi.hoisted(() => ({
  rows: [] as BotThreadRow[],
  remoteWork: [] as object[],
  groups: [] as object[],
  childKeys: [] as unknown[],
  remoteOpenable: true,
  connected: true,
  detail: null as null | { status: string; data: boolean; error: string | null },
  messages: [] as object[],
  life: [] as string[],
  draft: vi.fn(),
  openTask: vi.fn(),
  openThread: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "openable" ? state.remoteOpenable : true),
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
    updateTaskView: {},
    retryTask: { label: "retry", permissionAtom: () => "permission" },
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
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) => ({
    data:
      key === "task"
        ? { rows: state.rows, remoteWork: state.remoteWork }
        : key === "child"
          ? { groups: state.groups }
          : key === "routines"
            ? { tasks: [] }
            : null,
    error: null,
    isPending: false,
    isSuccess: key !== null,
    refresh: vi.fn(),
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
vi.mock("./MobileBotComputer", () => ({ MobileBotComputer: () => <p>bot computer</p> }));
vi.mock("./MobileBotLibrary", () => ({ MobileBotLibrary: () => <p>bot files</p> }));
vi.mock("./MobileBotMemory", () => ({
  MobileBotMemory: (props: { onDraft?: (text: string) => void }) => (
    <button onClick={() => props.onDraft?.("Remember this")}>Draft a note</button>
  ),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => <p>check-in form</p> }));
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
    remoteOpenable: true,
    connected: true,
    detail: null,
    messages: [],
    life: [],
  });
  state.draft.mockClear();
  state.openTask.mockClear();
  state.openThread.mockClear();
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

it("shows the bot's machines, work and routines on Home, and files and notes in Library", async () => {
  state.rows = [task("t1", "Check the disks")];
  await open();
  for (const text of [
    "Machines",
    "bot computer",
    "Work",
    "Check the disks",
    "Routines",
    "check-in form",
  ])
    expect(container.textContent).toContain(text);
  await press("Library");
  expect(container.textContent).toContain("bot files");
  expect(container.textContent).toContain("Notes");
  await press("Draft a note");
  expect(state.draft).toHaveBeenCalledWith("Remember this");
  expect(button("Library")).toBeUndefined();
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
  expect(state.openTask).toHaveBeenCalledWith("t1");
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
  expect(state.openTask).toHaveBeenCalledWith("t1");
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
  expect(container.textContent).toContain("Tasks are unavailable while GOAT Bot is offline");
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
