import React, { act, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";

type Rect = readonly [number, number, number, number];
type Measure = (callback: (x: number, y: number, width: number, height: number) => void) => void;
const roster = vi.hoisted(() => ({
  scrollRect: [0, 100, 400, 600] as Rect,
  rowRect: [0, 120, 400, 64] as Rect,
  pending: [] as Array<() => void>,
  rowLayout: null as (() => void) | null,
  scroll: {} as Record<string, ((event: unknown) => void) | undefined>,
}));
function measurer(rect: () => Rect): { measureInWindow: Measure } {
  return {
    measureInWindow: (callback) => {
      roster.pending.push(() => callback(...rect()));
    },
  };
}
// Home's work signals on bot rows are not under test here.
vi.mock("./useMobileBotRowSignals", () => ({ useMobileBotRowSignals: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({
    children,
    ref,
    ...handlers
  }: {
    children?: ReactNode;
    ref?: React.Ref<{ measureInWindow: Measure }>;
  } & Record<string, unknown>) => {
    React.useImperativeHandle(ref, () => measurer(() => roster.scrollRect));
    roster.scroll = handlers as typeof roster.scroll;
    return <div>{children}</div>;
  },
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  Alert: { alert: vi.fn() },
  Text: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <span aria-label={accessibilityLabel}>{children}</span>,
  Pressable: ({
    children,
    ref,
    onLayout,
    onPress,
    disabled,
    accessibilityState,
    accessibilityLabel,
    accessibilityHint,
    onAccessibilityAction,
    accessibilityActions,
    className,
  }: {
    children?: ReactNode;
    ref?: React.Ref<{ measureInWindow: Measure }>;
    onLayout?: () => void;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean; expanded?: boolean };
    accessibilityLabel?: string;
    accessibilityHint?: string;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    className?: string;
  }) => {
    React.useImperativeHandle(ref, () => measurer(() => roster.rowRect));
    if (onLayout) roster.rowLayout = onLayout;
    return (
      <button
        onClick={onPress}
        disabled={disabled}
        aria-pressed={accessibilityState?.selected}
        aria-expanded={accessibilityState?.expanded}
        aria-label={accessibilityLabel}
        aria-description={accessibilityHint}
        data-class={className}
        data-actions={accessibilityActions?.map((action) => action.label ?? action.name).join(",")}
        onKeyDown={(event) => onAccessibilityAction?.({ nativeEvent: { actionName: event.key } })}
      >
        {children}
      </button>
    );
  },
}));
const app = vi.hoisted(() => ({ active: true }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => app.active,
  useReduceMotionEnabled: () => false,
}));
// The phone's bot list around the roster: where a tap takes the person, and the roster's own reads.
const phone = vi.hoisted(() => ({
  selected: [] as Array<{ name: string; params?: object }>,
  bots: [] as ReadonlyArray<object>,
  hidden: [] as ReadonlyArray<object>,
  deleted: [] as ReadonlyArray<object>,
  // The roster's computer: its member support as last read, whether it is connected, and who may manage.
  supportsMembers: true,
  membersUnknown: false,
  connected: true,
  environmentId: "env" as string | null,
  mayManage: false,
}));
const homeRoute = { index: 0, routes: [{ key: "home", name: "Home" }] };
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ getState: () => homeRoute, getParent: () => undefined }),
  useNavigationState: (select: (state: typeof homeRoute) => unknown) => select(homeRoute),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: { name: string; params?: object }) =>
    phone.selected.push(detail),
}));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: phone.bots,
    groups: { main: null, members: [], hidden: phone.hidden, deleted: phone.deleted },
    supportsMembers: phone.supportsMembers,
    membersUnknown: phone.membersUnknown,
    connected: phone.connected,
    computerLabel: "Studio Mac",
    environmentId: phone.environmentId,
    slackEnabled: false,
    listedBots: [],
    refreshBots: () => {},
    retryBots: () => {},
    error: null,
  }),
}));
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileBotManage", () => ({
  useMobileBotManage: () => ({
    canCreate: phone.connected,
    canManage: phone.connected && phone.mayManage,
    canEdit: false,
    mayManage: phone.mayManage,
  }),
}));
vi.mock("./MobileBotEditSheet", () => ({ MobileBotEditSheet: () => null }));
vi.mock("./MobileNewBotStatus", () => ({ MobileNewBotStatus: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request" }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => <span /> }));
const face = vi.hoisted(() => ({ items: [] as ReadonlyArray<object> }));
vi.mock("./GoatBotFace", () => ({
  GoatBotFaceAvatar: (props: { motion: object | null; emoji?: string | null }) => (
    <span data-motion={props.motion ? "moving" : "still"} data-picture={props.emoji ?? ""} />
  ),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: link.savedRef, threadId: "bot" } }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
// The open asks read: a real query view over this atom. Like a server, what it holds (`state`)
// reaches the screen only when the query is read again, and every read is counted.
const query = vi.hoisted(() => ({
  reads: 0,
  state: null as null | Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>>,
  read: null as null | Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
}));
vi.mock("@goat/client-runtime/state/runtime", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  // Kept alive: nothing subscribes to it between reads.
  const state = A.keepAlive(A.make<AsyncResult.AsyncResult<unknown, unknown>>(R.initial(true)));
  query.state = state;
  const read = A.make((get) => {
    query.reads += 1;
    return get.once(state);
  });
  query.read = read;
  return { createEnvironmentRpcQueryAtomFamily: () => () => read };
});
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
// The app's computers: the bot computer "env" stays in the catalog throughout.
vi.mock("../../connection/catalog", async () => {
  const { Atom: A } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: A.make({ isReady: true, entries: new Map([["env", { enabled: true }]]) }),
    },
  };
});
// The bot computer's connection as the app sees it; each test sets it.
const link = vi.hoisted(() => ({
  phase: "connected",
  /** The bot this device saved; the Home claim can move to another computer before it changes. */
  savedRef: "env",
  /** The computer's config; null before anything was read from it (a cold start offline). */
  config: { environment: { capabilities: { goatBotOpenAsks: true } } } as object | null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: link.phase },
          entry: { target: { label: "Studio Mac" } },
          serverConfig: link.config,
        },
      ],
      [
        "old",
        {
          connection: { phase: "disconnected" },
          entry: { target: { label: "Old Mac" } },
          serverConfig: { environment: { capabilities: { goatBotOpenAsks: true } } },
        },
      ],
    ]),
  }),
}));
vi.mock("./GoatBotMessageParts", () => ({ goatBotTime: (iso: string) => iso.slice(11, 16) }));
vi.mock("./useMobileMemberStatus", () => ({
  useMobileMemberWaitingCount: () => 0,
  useMobileMemberStatus: () => ({ waitingCount: 0, latest: undefined, unread: false }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => face.items,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => <span /> }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    accessibilityLabel,
    accessibilityHint,
    disabled,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-description={accessibilityHint}
      disabled={disabled}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));

import { MobileBotList } from "./MobileBotList";
import { MobileBotRosterView } from "./MobileBotRosterView";
import { resetKeptPerComputerForTests } from "./useKeptPerComputer";

const at = "2026-11-11T10:00:00.000Z";
const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const profile = (botId: string, name: string, extra: object = {}) =>
  decodeProfile({
    botId,
    role: "member",
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: `thread-${botId}`,
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
const scout = profile("scout", "Scout");
const quiet = profile("quiet", "Quiet", { hidden: true });
const ask = (botId: string, taskId: string, text: string, askedAt: string) => ({
  botId,
  taskId,
  kind: "question" as const,
  text,
  askedAt,
});
const read = (asks: object[], total = asks.length, truncated = false) =>
  AsyncResult.success({ asks, total, truncated });

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
let registry = AtomRegistry.make();
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  app.active = true;
});
async function showRoster(
  visible: boolean,
  onOpenTask = vi.fn(),
  more: { readonly members?: ReadonlyArray<BotProfile>; readonly onUnknownBot?: () => void } = {},
) {
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <MobileBotRosterView
          mainEnvironmentId={EnvironmentId.make("env")}
          bots={[
            { kind: "main", profile: null },
            { kind: "member", profile: scout },
            ...(more.members ?? []).map((profile) => ({ kind: "member" as const, profile })),
          ]}
          slackEnabled={false}
          onOpenBot={vi.fn()}
          onOpenTask={onOpenTask}
          onUnknownBot={more.onUnknownBot}
          visible={visible}
          members={{
            hidden: [quiet],
            deleted: [],
            canCreate: true,
            onNewBot: () => {},
            onLongPressBot: () => {},
            canRestore: false,
            onRestoreDeleted: () => {},
          }}
        />
      </RegistryContext>,
    ),
  );
  return onOpenTask;
}
/** What the server would answer next, without anyone reading it yet. */
function stage(result: AsyncResult.AsyncResult<unknown, unknown>) {
  if (query.state !== null) registry.set(query.state, result);
}
/** A read that arrives with this answer. */
function serve(result: AsyncResult.AsyncResult<unknown, unknown>) {
  stage(result);
  if (query.read !== null) act(() => registry.refresh(query.read!));
}
const stripButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label*="waiting for you"]');

it("reads every bot's asks, labels each by its bot, and opens the task in that bot, a hidden one too", async () => {
  registry = AtomRegistry.make();
  const onOpenTask = await showRoster(true);
  serve(
    read([
      ask("quiet", "task-q", "Approve the deploy?", "2026-11-11T10:05:00.000Z"),
      ask("main", "task-m", "Which project?", "2026-11-11T09:40:00.000Z"),
      ask("someone-new", "task-x", "Sign in again", "2026-11-11T09:30:00.000Z"),
    ]),
  );
  await act(async () => {});
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "3 waiting for you. Quiet: Approve the deploy?",
  );
  await act(async () => stripButton()?.click());
  const row = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  await act(async () => row("Quiet, 10:05: Approve the deploy?")?.click());
  expect(onOpenTask).toHaveBeenLastCalledWith({ kind: "member", profile: quiet }, "task-q");
  await act(async () => row("GOAT Bot, 09:40: Which project?")?.click());
  expect(onOpenTask).toHaveBeenLastCalledWith({ kind: "main", profile: null }, "task-m");
  // A bot the roster does not know yet is named plainly and opens nothing.
  expect(row("A bot, 09:30: Sign in again")?.disabled).toBe(true);
  expect(onOpenTask).toHaveBeenCalledTimes(2);
});

it("asks for the bot list again once when an ask names a bot it does not know, then opens that ask in it", async () => {
  registry = AtomRegistry.make();
  const onUnknownBot = vi.fn();
  const onOpenTask = await showRoster(true, vi.fn(), { onUnknownBot });
  serve(read([ask("nova", "task-n", "Which branch?", "2026-11-11T10:20:00.000Z")]));
  await act(async () => {});
  expect(onUnknownBot).toHaveBeenCalledTimes(1);
  // Another read naming the same unknown bot does not ask again while the roster stays in view.
  serve(read([ask("nova", "task-n", "Which branch?", "2026-11-11T10:20:00.000Z")]));
  await act(async () => {});
  await showRoster(true, onOpenTask, { onUnknownBot });
  expect(onUnknownBot).toHaveBeenCalledTimes(1);
  // The bot list comes back with the new member: the ask names it and opens its task there.
  const nova = profile("nova", "Nova");
  await showRoster(true, onOpenTask, { onUnknownBot, members: [nova] });
  await act(async () => stripButton()?.click());
  const row = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Nova, 10:20: Which branch?"]',
  );
  expect(row?.disabled).toBe(false);
  await act(async () => row?.click());
  expect(onOpenTask).toHaveBeenLastCalledWith({ kind: "member", profile: nova }, "task-n");
  expect(onUnknownBot).toHaveBeenCalledTimes(1);
});

it("asks again for an unknown bot each time the roster comes back into view, not while it is covered", async () => {
  registry = AtomRegistry.make();
  const onUnknownBot = vi.fn();
  await showRoster(true, vi.fn(), { onUnknownBot });
  serve(read([ask("nova", "task-n", "Which branch?", "2026-11-11T10:20:00.000Z")]));
  await act(async () => {});
  expect(onUnknownBot).toHaveBeenCalledTimes(1);
  await showRoster(false, vi.fn(), { onUnknownBot });
  await act(async () => {});
  expect(onUnknownBot).toHaveBeenCalledTimes(1);
  await showRoster(true, vi.fn(), { onUnknownBot });
  serve(read([ask("nova", "task-n", "Which branch?", "2026-11-11T10:20:00.000Z")]));
  await act(async () => {});
  expect(onUnknownBot).toHaveBeenCalledTimes(2);
});

it("shows a failed refresh as failed even after an empty read, and reads again on Try again", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  serve(read([]));
  await act(async () => {});
  expect(stripButton()).toBeNull();
  const empty = read([]);
  serve(
    AsyncResult.failure(Cause.fail(new Error("offline")), {
      previousSuccess: Option.some(empty),
    }),
  );
  await act(async () => {});
  const retry = container.querySelector<HTMLButtonElement>(
    '[aria-label="Couldn\'t check what waits for you. Try again"]',
  );
  expect(retry).not.toBeNull();
  const before = query.reads;
  await act(async () => retry?.click());
  expect(query.reads).toBeGreaterThan(before);
});

it("keeps the asks it has when a refresh fails, marked out of date, and reads again on Try again", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  const earlier = read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:10:00.000Z")]);
  serve(earlier);
  await act(async () => {});
  serve(
    AsyncResult.failure(Cause.fail(new Error("offline")), {
      previousSuccess: Option.some(earlier),
    }),
  );
  await act(async () => {});
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "1 waiting for you, may be out of date. Scout: Which machine?",
  );
  expect(
    container.querySelector('[aria-label="Couldn\'t check what waits for you. Try again"]'),
  ).toBeNull();
  const retry = container.querySelector<HTMLButtonElement>(
    '[aria-label="Couldn\'t refresh, this may be out of date. Try again"]',
  );
  expect(retry).not.toBeNull();
  const before = query.reads;
  await act(async () => retry?.click());
  expect(query.reads).toBeGreaterThan(before);
});

it("an asks read refused for access shows nothing of the earlier answer it still holds", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  const earlier = read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:10:00.000Z")]);
  serve(earlier);
  await act(async () => {});
  expect(container.textContent).toContain("Which machine?");
  // This phone lost the scope: the read is refused, and the query still holds its earlier answer.
  serve(
    AsyncResult.failure(
      Cause.fail({ _tag: "EnvironmentAuthorizationError", message: "Not allowed." }),
      { previousSuccess: Option.some(earlier) },
    ),
  );
  await act(async () => {});
  expect(container.textContent).not.toContain("Which machine?");
});

it("reads again when the roster comes back into view, so an ask that arrived meanwhile shows", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  serve(read([]));
  await act(async () => {});
  // A workspace page covers the roster, which stays mounted underneath.
  await showRoster(false);
  const before = query.reads;
  stage(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:10:00.000Z")]));
  await act(async () => {});
  expect(stripButton()).toBeNull();
  await showRoster(true);
  await act(async () => {});
  expect(query.reads).toBeGreaterThan(before);
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "1 waiting for you. Scout: Which machine?",
  );
});

it("says a partial read is partial: none found before the server stopped, and fewer rows than the total", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  // The server bounds the tasks it reads before it finds asks, so it can stop with none found.
  serve(read([], 0, true));
  await act(async () => {});
  expect(container.textContent).toContain("Needs you");
  expect(container.textContent).not.toContain("Needs you ·");
  expect(container.textContent).toContain("Some waiting work couldn't be read.");
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:10:00.000Z")], 3));
  await act(async () => {});
  await act(async () => stripButton()?.click());
  expect(container.textContent).toContain("Showing the newest 1 of 3.");
});

it("on the phone's bot list, an ask opens the GoatBot screen of its bot on that task, a hidden bot's too", async () => {
  registry = AtomRegistry.make();
  phone.selected.length = 0;
  phone.bots = [
    { kind: "main", profile: null },
    { kind: "member", profile: scout },
  ];
  phone.hidden = [quiet];
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <MobileBotList />
      </RegistryContext>,
    ),
  );
  serve(
    read([
      ask("quiet", "task-q", "Approve the deploy?", "2026-11-11T10:05:00.000Z"),
      ask("main", "task-m", "Which project?", "2026-11-11T09:40:00.000Z"),
    ]),
  );
  await act(async () => {});
  await act(async () => stripButton()?.click());
  const row = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  await act(async () => row("Quiet, 10:05: Approve the deploy?")?.click());
  await act(async () => row("GOAT Bot, 09:40: Which project?")?.click());
  expect(phone.selected).toEqual([
    { name: "GoatBot", params: { botId: "quiet", taskId: "task-q" } },
    { name: "GoatBot", params: { taskId: "task-m" } },
  ]);
});

function setupLink(phase: string) {
  registry = AtomRegistry.make();
  link.phase = phase;
  link.savedRef = "env";
  link.config = { environment: { capabilities: { goatBotOpenAsks: true } } };
  resetKeptPerComputerForTests();
}

it("keeps the asks it last read while the computer is offline, says they may be out of date, and offers no retry", async () => {
  setupLink("connected");
  await showRoster(true);
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:05:00.000Z")]));
  await act(async () => {});
  link.phase = "disconnected";
  await showRoster(true);
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "1 waiting for you, offline, may be out of date. Scout: Which machine?",
  );
  expect(container.textContent).toContain("Offline · this may be out of date");
  expect(container.textContent).not.toContain("Try again");
  link.phase = "connected";
});

it("keeps the last asks through a failed refresh when the computer then goes offline", async () => {
  setupLink("connected");
  await showRoster(true);
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:05:00.000Z")]));
  await act(async () => {});
  serve(AsyncResult.failure(Cause.fail(new Error("socket"))));
  await act(async () => {});
  link.phase = "disconnected";
  await showRoster(true);
  expect(container.textContent).toContain("Scout: Which machine?");
  expect(container.textContent).toContain("Offline · this may be out of date");
  link.phase = "connected";
});

it("back online before the first read answers, keeps the last asks marked out of date until it does", async () => {
  setupLink("connected");
  await showRoster(true);
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:05:00.000Z")]));
  await act(async () => {});
  link.phase = "disconnected";
  await showRoster(true);
  // Back online: the read was sent and has not answered.
  serve(AsyncResult.initial(true));
  link.phase = "connected";
  await showRoster(true);
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "1 waiting for you, may be out of date. Scout: Which machine?",
  );
  expect(container.textContent).toContain("This may be out of date");
  expect(container.textContent).not.toContain("Offline · this may be out of date");
  serve(read([]));
  await showRoster(true);
  expect(container.textContent).not.toContain("Which machine?");
  expect(container.textContent).not.toContain("may be out of date");
});

it("says what waits is unavailable when the computer is offline before any read answered", async () => {
  setupLink("disconnected");
  await showRoster(true);
  expect(container.textContent).toContain("Needs you · unavailable while Studio Mac is offline");
  link.phase = "connected";
});

/** The phone's bot list, rendered with its real panel and view, for one state of the roster's computer. */
async function showPhoneList(state: Partial<typeof phone>) {
  registry = AtomRegistry.make();
  resetKeptPerComputerForTests();
  Object.assign(phone, {
    selected: [],
    bots: [{ kind: "main", profile: null }],
    hidden: [],
    deleted: [],
    supportsMembers: true,
    membersUnknown: false,
    connected: true,
    environmentId: "env",
    mayManage: false,
    ...state,
  });
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <MobileBotList />
      </RegistryContext>,
    ),
  );
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("New bot"),
  );
}

it("New bot says Coming soon only for a computer that says it has no member bots", async () => {
  const older = await showPhoneList({ supportsMembers: false });
  expect(older?.textContent).toBe("New bot · Coming soon");
  const offline = "Unavailable while Studio Mac is offline";
  for (const [state, why] of [
    [{ connected: false }, offline],
    // Nothing read from this computer yet: unknown, not an older server.
    [{ connected: false, supportsMembers: false, membersUnknown: true }, offline],
    [
      { connected: false, supportsMembers: false, membersUnknown: true, environmentId: null },
      "Unavailable until a computer with GOAT Bot connects",
    ],
  ] as const) {
    const add = await showPhoneList(state);
    expect(add?.textContent).toBe("New bot");
    expect(add?.disabled).toBe(true);
    expect(add?.getAttribute("aria-description")).toBe(why);
  }
  const online = await showPhoneList({});
  expect(online?.textContent).toBe("New bot");
  expect(online?.disabled).toBe(false);
});

it("offline, a deleted bot's Restore stays in view, disabled with the reason; back online it restores", async () => {
  const gone = profile("gone", "Gone", { state: "deleted" });
  await showPhoneList({ connected: false, mayManage: true, deleted: [gone] });
  const restore = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Restore Gone"]');
  expect(restore()?.disabled).toBe(true);
  expect(restore()?.getAttribute("aria-description")).toBe(
    "Unavailable while Studio Mac is offline",
  );
  expect(container.textContent).toContain("Restore: unavailable while Studio Mac is offline");
  await showPhoneList({ connected: true, mayManage: true, deleted: [gone] });
  expect(restore()?.disabled).toBe(false);
});

it("reads the asks of the computer the roster shows, not a saved bot on a computer the Home claim has left", async () => {
  setupLink("connected");
  // The Home claim moved to "env"; the saved bot still names "old", which is offline.
  link.savedRef = "old";
  await showRoster(true);
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:05:00.000Z")]));
  await act(async () => {});
  expect(stripButton()?.getAttribute("aria-label")).toBe(
    "1 waiting for you. Scout: Which machine?",
  );
  expect(container.textContent).not.toContain("Old Mac");
});

it("says what waits is unavailable after a cold start offline, before anything was read from the computer", async () => {
  setupLink("disconnected");
  link.config = null;
  await showRoster(true);
  expect(container.textContent).toContain("Needs you · unavailable while Studio Mac is offline");
});
