import { act, useEffect, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const session = vi.hoisted(() => ({
  rows: [] as GoatBotRow[],
  canSend: true,
  onSend: vi.fn(() => true),
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
  // The home's reads: null while loading, "failed" when the read failed.
  routines: null as null | "failed" | ReadonlyArray<object>,
  tasks: null as null | "failed" | ReadonlyArray<object>,
  dispatch: vi.fn(),
  scrollToIndex: vi.fn(
    (_params: { index: number; viewPosition: number; viewOffset: number }) => {},
  ),
  homeKeys: [] as string[],
}));
vi.mock("react-native", () => ({
  // Views report where they sit, as native layout does once they mount.
  View: function View({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { y: number } } }) => void;
  }) {
    useEffect(() => onLayout?.({ nativeEvent: { layout: { y: 240 } } }), [onLayout]);
    return <div>{children}</div>;
  },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FlatList: function FlatList(props: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
    ref?: Ref<{ scrollToIndex: typeof session.scrollToIndex }>;
  }) {
    useImperativeHandle(props.ref, () => ({ scrollToIndex: session.scrollToIndex }));
    session.homeKeys = props.data.map((item) => item.key);
    return (
      <div>
        {props.data.map((item, index) => (
          <div key={item.key}>{props.renderItem({ item, index })}</div>
        ))}
      </div>
    );
  },
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <section aria-label="Work sheet">{children}</section> : null,
  Alert: { alert: vi.fn() },
  Switch: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    accessibilityState,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean };
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      aria-disabled={accessibilityState?.disabled}
      value={value}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    appearance: { baseFontSize: 16 },
  }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
// The header chip opens the home; it renders as a button here.
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
vi.mock("./GoatBotFace", () => ({
  GoatBotHeaderFace: (props: { title: string; onPress?: () => void }) =>
    props.onPress ? (
      <button aria-label={`Open ${props.title} home`} onClick={props.onPress}>
        {props.title}
      </button>
    ) : null,
  GoatBotFaceAvatar: () => null,
  GoatBotProgressFace: () => null,
}));
vi.mock("./GoatBotShimmerText", () => ({ GoatBotShimmerText: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data?: ReadonlyArray<{ id: string }>;
    renderItem?: (info: { item: { id: string } }) => ReactNode;
  }) => (
    <div>
      {props.data?.map((item) => (
        <div key={item.id}>{props.renderItem?.({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: session.dispatch }),
  StackActions: { push: (name: string, params: object) => ({ name, params }) },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../settings/SettingsMemoryRouteScreen", () => ({ MemoryReportLink: () => null }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({
  // Like the real session, a deleted member's chat cannot send.
  useMobileGoatBotSession: (
    _visible: boolean,
    _taskId: unknown,
    member: { state?: string } | null = null,
  ) => ({
    availability: "ready",
    rows: session.rows,
    canSend: session.canSend && member?.state !== "deleted",
    attachmentSupport: null,
    onSend: session.onSend,
    onRetryInput: () => {},
    replyingSince: null,
    activity: null,
    supportsTaskThreads: true,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotThreads: () => "tasks",
    listChildWork: () => "child",
    listBotNotes: () => "notes",
    updateTaskView: {},
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => "routines",
    setScheduledTaskEnabled: { permissionAtom: () => "permission" },
    runScheduledTaskNow: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          serverConfig: {
            environment: { capabilities: { goatBotTaskThreads: true, goatBotNotes: true } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("./goatBotHomeMode", async (original) => ({
  ...(await original<typeof import("./goatBotHomeMode")>()),
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: true }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./MobileBotCheckInForm", () => ({ MobileBotCheckInForm: () => null }));
// A member's model menu reads server config and native menus this test does not load.
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
// The home sheet's peek reads thread detail, which needs the native runtime.
vi.mock("./MobileBotPeek", () => ({
  MobileBotPeek: (props: { entry: { row: { task: { taskId: string } } } }) => (
    <section aria-label={`Peek ${props.entry.row.task.taskId}`} />
  ),
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("./MobileBotComputer", () => ({ MobileBotComputer: () => null }));
vi.mock("./MobileBotLibrary", () => ({ MobileBotLibrary: () => null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => {
    const value =
      atom === "routines" ? session.routines : atom === "tasks" ? session.tasks : undefined;
    const failed = value === "failed";
    const data =
      value === undefined
        ? atom === "notes"
          ? { revision: "r", notes: [], truncated: false }
          : null
        : failed || value === null
          ? null
          : atom === "routines"
            ? { tasks: value }
            : { rows: value };
    return {
      data,
      cause: null,
      error: failed ? new Error("failed") : null,
      isPending: data === null && !failed,
      isSuccess: data !== null,
      refresh: () => {},
    };
  },
}));

import { GoatBotScreen } from "./GoatBotScreen";

const at = "2026-11-11T02:00:00.000Z";
const decodeRow = Schema.decodeUnknownSync(BotThreadRow);
const listedTask = (taskId: string) =>
  decodeRow({
    kind: "task",
    task: { taskId, title: "Check disks", status: "running", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
const routine = (id: string, title: string) => ({
  id,
  title,
  prompt: "Check the disks",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
  threadId: "bot",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
});
const event = (subject: { kind: "routine" | "task"; id: string; name: string }): GoatBotRow =>
  ({
    kind: "event",
    id: `event-${subject.id}`,
    text: `${subject.kind === "routine" ? "Routine" : "Task"} ${subject.name} ran`,
    createdAt: at,
    subject,
  }) as GoatBotRow;

async function render(rows: GoatBotRow[]) {
  session.rows = rows;
  session.dispatch.mockClear();
  session.scrollToIndex.mockClear();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<GoatBotScreen visible />));
  return {
    container,
    rerender: () => act(async () => root.render(<GoatBotScreen visible />)),
    sheet: () => container.querySelector('[aria-label="Work sheet"]'),
    button: (label: string) =>
      [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === label || button.textContent === label,
      ),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
async function press(button: HTMLButtonElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("a routine's event line opens Home with that routine scrolled into view, even from Library", async () => {
  session.routines = [routine("r-other", "Inbox sweep"), routine("r-1", "Daily check")];
  session.tasks = [];
  const view = await render([event({ kind: "routine", id: "r-1", name: "Daily check" })]);
  // The person last left the sheet on Library.
  await press(view.button("Open GOAT Bot home"));
  await press(view.button("Library"));
  await press(view.button("Close"));
  await press(view.button("Routine Daily check ran. Open routine Daily check"));
  expect(view.sheet()?.textContent).toContain("Daily check");
  expect(view.sheet()?.textContent).toContain("Routines");
  // Home lists the routine and the list scrolls to its row, clear of the sticky tabs.
  expect(session.scrollToIndex).toHaveBeenCalledTimes(1);
  const [scroll] = session.scrollToIndex.mock.calls[0] ?? [];
  expect(session.homeKeys[scroll?.index ?? -1]).toBe("routines");
  expect(scroll).toMatchObject({ viewPosition: 0, viewOffset: 56 - 240 });
  await view.unmount();
});

it("a routine that is gone leaves its event line plain; one still loading or failed still opens Home", async () => {
  session.tasks = [];
  session.routines = [routine("r-other", "Inbox sweep")];
  const line = event({ kind: "routine", id: "r-1", name: "Daily check" });
  const view = await render([line]);
  expect(view.button("Routine Daily check ran. Open routine Daily check")).toBeUndefined();
  expect(view.container.textContent).toContain("Routine Daily check ran");
  for (const state of [null, "failed"] as const) {
    session.routines = state;
    await view.rerender();
    await press(view.button("Routine Daily check ran. Open routine Daily check"));
    expect(view.sheet()?.textContent).toContain(
      state === null ? "Loading routines" : "Couldn't load routines",
    );
    await press(view.button("Close"));
  }
  await view.unmount();
});

it("a task's event line peeks at a listed task in Home, and opens the task screen for one that left the list", async () => {
  session.routines = [];
  session.tasks = [listedTask("task-1")];
  const view = await render([
    event({ kind: "task", id: "task-1", name: "Check disks" }),
    event({ kind: "task", id: "task-gone", name: "Old work" }),
  ]);
  await press(view.button("Task Check disks ran. Open task Check disks"));
  expect(view.container.querySelector('[aria-label="Peek task-1"]')).not.toBeNull();
  expect(session.dispatch).not.toHaveBeenCalled();
  await press(view.button("Close"));
  await press(view.button("Task Old work ran. Open task Old work"));
  expect(view.sheet()).toBeNull();
  expect(session.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ name: "GoatBot", params: { taskId: "task-gone" } }),
  );
  await view.unmount();
});

it("a task list still loading or failed is not read as the task being gone", async () => {
  session.routines = [];
  session.tasks = null;
  const view = await render([event({ kind: "task", id: "task-1", name: "Check disks" })]);
  await press(view.button("Task Check disks ran. Open task Check disks"));
  expect(session.dispatch).not.toHaveBeenCalled();
  expect(view.sheet()).not.toBeNull();
  // Once the list arrives with the task, Home peeks at it.
  session.tasks = [listedTask("task-1")];
  await view.rerender();
  expect(view.container.querySelector('[aria-label="Peek task-1"]')).not.toBeNull();
  await press(view.button("Close"));
  session.tasks = "failed";
  await view.rerender();
  await press(view.button("Task Check disks ran. Open task Check disks"));
  expect(session.dispatch).not.toHaveBeenCalled();
  expect(view.sheet()).not.toBeNull();
  await view.unmount();
});
