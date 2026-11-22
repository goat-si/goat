import "./goatBotNativeModules.testkit";
import type { GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { useState, useSyncExternalStore } from "react";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, vi } from "vite-plus/test";
import {
  ChannelTaskId,
  type BotThreadRow,
  type ChannelListBotThreadsResult,
} from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";

const taskChanges = Atom.make(AsyncResult.success({ subscription: 1, value: { revision: 0 } }));

const nativePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  Platform: nativePlatform,
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
  openTask: vi.fn(),
  snoozeCapable: false,
  checkSnoozes: vi.fn(),
  snoozePage: vi.fn(),
  snoozeCheck: {
    data: null as null | Pick<ChannelListBotThreadsResult, "activeSnoozes">,
    error: null as string | null,
    refresh: vi.fn(),
  },
  // A server that looks tasks up by id and searches their titles.
  lookupCapable: false,
  lookup: vi.fn(),
  readApprovalAtoms: false,
  update: vi.fn(),
}));

// The real face module draws the chip's face; only its native drawing and styling stand in.
vi.mock("react-native-reanimated", () => {
  const chain = { duration: () => chain, reduceMotion: () => chain };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    useAnimatedStyle: (style: () => unknown) => style(),
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
vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  // No config: the Machines card asks as it does on a server without bot members.
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) =>
    useSyncExternalStore(
      (notify) => (atom === taskChanges ? appAtomRegistry.subscribe(atom, notify) : () => {}),
      () => (state.readApprovalAtoms && Atom.isAtom(atom) ? appAtomRegistry.get(atom) : true),
    ),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: () => Atom.make({ connection: { phase: "connected" } }),
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => false,
  sessionHasScope: () => true,
  readEnvironmentScope: () => true,
  environmentSession: { sessionStateAtom: () => Atom.make(null) },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => Atom.make({ title: "Waiting worker" }) },
  environmentThreadDetails: { pendingRequestsAtom: () => Atom.make(null) },
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
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardEvents: { addListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    // Home's shared current work; its links are not read in this file.
    homeCurrentOpenableWorkAtom: () => "home-current",
    listBotThreads: () => "task",
    checkBotSnoozes: state.checkSnoozes,
    listBotThreadsPage: { label: "work page", run: state.snoozePage },
    snoozeBotTask: { permissionAtom: () => "permission" },
    unsnoozeBotTask: { permissionAtom: () => "permission" },
    listChildWork: () => "child",
    listBotArtifacts: () => "artifacts",
    readBotArtifact: {},
    listTasks: () => "computer",
    updateTaskView: { label: "update", permissionAtom: () => "permission", run: state.update },
    retryTask: { label: "retry", permissionAtom: () => "permission", run: state.retry },
    getBotTask: { label: "lookup", permissionAtom: () => "permission", run: state.lookup },
    searchBotTasks: { label: "search", permissionAtom: () => "permission" },
    taskChanges: () => taskChanges,
    taskChangesPermission: () => "permission",
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    botTriggerSettingsPermissionAtom: () => "permission",
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
                goatBotTaskSnooze: state.snoozeCapable,
                goatBotChildWork: true,
                goatBotMembers: true,
                goatBotTaskLookupSearch: state.lookupCapable,
                goatBotTaskChanges: state.lookupCapable,
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
  pickMobileGoatBotHomeEnvironment: () => ({ environmentId: "env", connected: state.connected }),
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
        : key === "snooze-check"
          ? state.snoozeCheck
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
  try {
    if (root) await act(async () => root?.unmount());
  } finally {
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  }
});

function reset() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = true;
  state.snoozeCapable = false;
  state.checkSnoozes.mockReset();
  state.snoozePage.mockReset();
  state.openTask.mockClear();
  state.snoozeCheck.data = null;
  state.snoozeCheck.error = null;
  state.snoozeCheck.refresh.mockReset();
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
  state.readApprovalAtoms = false;
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
        onOpenTask={state.openTask}
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
export async function renderWork(element: ReactNode) {
  if (!root) root = createRoot(container);
  await act(async () => root?.render(element));
}

export { container, nativePlatform, press, render, reset, state, taskChanges, WorkWithChip };
