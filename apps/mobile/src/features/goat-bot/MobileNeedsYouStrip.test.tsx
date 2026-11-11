import React, { act, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotProfile } from "@goat/contracts";
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
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => <span /> }));
const face = vi.hoisted(() => ({ items: [] as ReadonlyArray<object> }));
vi.mock("./GoatBotFace", () => ({
  GoatBotFaceAvatar: (props: { motion: object | null; emoji?: string | null }) => (
    <span data-motion={props.motion ? "moving" : "still"} data-picture={props.emoji ?? ""} />
  ),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "bot" } }),
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
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: "connected" },
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
    disabled,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { MobileBotRosterView } from "./MobileBotRosterView";

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
async function showRoster(visible: boolean, onOpenTask = vi.fn()) {
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <MobileBotRosterView
          bots={[
            { kind: "main", profile: null },
            { kind: "member", profile: scout },
          ]}
          slackEnabled={false}
          onOpenBot={vi.fn()}
          onOpenTask={onOpenTask}
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
  container.querySelector<HTMLButtonElement>('button[aria-label*="waiting for you."]');

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

it("says a partial read is partial: a count with no readable ask, and fewer rows than the total", async () => {
  registry = AtomRegistry.make();
  await showRoster(true);
  serve(read([], 4, true));
  await act(async () => {});
  expect(container.textContent).toContain("Needs you · 4+");
  expect(container.textContent).toContain("Some waiting work couldn't be read.");
  serve(read([ask("scout", "task-s", "Which machine?", "2026-11-11T10:10:00.000Z")], 3));
  await act(async () => {});
  await act(async () => stripButton()?.click());
  expect(container.textContent).toContain("Showing the newest 1 of 3.");
});
