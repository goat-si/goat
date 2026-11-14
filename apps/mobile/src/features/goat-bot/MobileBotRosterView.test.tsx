import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
function flushMeasurements() {
  while (roster.pending.length > 0) roster.pending.shift()?.();
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
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
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
// The strip has its own tests and reads the server's open asks.
vi.mock("./MobileNeedsYouStrip", () => ({ MobileNeedsYouStrip: () => null }));
// Each member's own status, as channel.getBotStatus answers it for that bot.
const members = vi.hoisted(() => ({
  status: {} as Record<
    string,
    {
      waitingCount: number;
      latest?: { text: string; at: string; author: "bot" | "person" };
      unread: boolean;
      waitingState?: "ready" | "pending" | "unavailable";
    }
  >,
}));
vi.mock("./useMobileMemberStatus", () => ({
  useMobileMemberStatus: (bot: { botId: string }) => {
    const shown = members.status[bot.botId] ?? {
      waitingCount: bot.botId === "research" ? 2 : 0,
      latest: undefined,
      unread: false,
    };
    return { ...shown, status: { waitingCount: shown.waitingCount, latest: shown.latest } };
  },
}));
// Each bot's work signals as Home's shared value gives them; none where Home does not govern.
const signals = vi.hoisted(() => ({
  byBot: {} as Record<string, { unread: number | null; missing: string | null; spoken: string[] }>,
}));
vi.mock("./useMobileBotRowSignals", () => ({
  useMobileBotRowSignals: (input: { botId: string }) => signals.byBot[input.botId] ?? null,
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
import { MobileBotRosterView, MobileHomeSegments } from "./MobileBotRosterView";

const at = "2026-11-04T10:00:00.000Z";
const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

it("switches both segments and exposes the selected state", async () => {
  function Harness() {
    const [mode, setMode] = React.useState<"bot" | "thread">("thread");
    return <MobileHomeSegments mode={mode} onSelect={setMode} />;
  }
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  const [bots, threads] = container.querySelectorAll("button");
  expect(threads?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => bots?.click());
  expect(bots?.getAttribute("aria-pressed")).toBe("true");
  expect(threads?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => threads?.click());
  expect(threads?.getAttribute("aria-pressed")).toBe("true");
  expect(bots?.getAttribute("aria-pressed")).toBe("false");
});

it("lists only bots: the main bot as a tile with its latest message, and no task or thread rows", async () => {
  const open = vi.fn();
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        slackEnabled
        preview="Latest reply"
        unread
        onOpenBot={open}
      />,
    ),
  );
  expect(container.textContent).toContain("GOAT Bot");
  expect(container.textContent).toContain("Latest reply");
  expect(container.textContent).toContain("Also in Slack");
  expect(container.textContent).not.toContain("Show more");
  expect(container.querySelector("button:disabled")?.textContent).toContain("Coming soon");
  const tile = container.querySelector('[aria-label="GOAT Bot, unread"]') as HTMLButtonElement;
  await act(async () => tile.click());
  expect(open).toHaveBeenCalledWith({ kind: "main", profile: null });
});

it("shows the waiting face on the main bot for a waiting task the roster hides", async () => {
  face.items = [
    {
      item: {
        type: "notification",
        ledgerTask: { taskId: "quiet", taskVersion: 2, status: "waiting_input" },
      },
    },
  ];
  try {
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MobileBotRosterView
          bots={[{ kind: "main", profile: null }]}
          slackEnabled={false}
          onOpenBot={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="Waiting for you, GOAT Bot"]')).not.toBeNull();
  } finally {
    face.items = [];
  }
});

describe("the roster's main face", () => {
  const working = [
    {
      item: {
        type: "notification",
        ledgerTask: {
          taskId: "busy",
          taskVersion: 1,
          status: "running",
          createdAt: at,
          updatedAt: at,
        },
      },
    },
  ];
  const props = {
    bots: [{ kind: "main" as const, profile: null }],
    slackEnabled: false,
    onOpenBot: () => {},
  };
  const motion = () => container.querySelector("[data-motion]")?.getAttribute("data-motion");

  async function showWorkingRoster() {
    face.items = working;
    roster.scrollRect = [0, 100, 400, 600];
    roster.rowRect = [0, 120, 400, 64];
    roster.pending.length = 0;
    root = createRoot(container);
    await act(async () => root?.render(<MobileBotRosterView {...props} />));
  }

  afterEach(() => {
    face.items = [];
  });

  it("moves only after the row is measured inside the roster", async () => {
    await showWorkingRoster();
    expect(motion()).toBe("still");
    await act(async () => {
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("moving");
  });

  it("stays still when the row is measured outside the roster", async () => {
    await showWorkingRoster();
    roster.rowRect = [0, 760, 400, 64];
    await act(async () => {
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("still");
    roster.rowRect = [0, 20, 400, 64];
    await act(async () => {
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("still");
  });

  it("stops as a scroll starts, ignores a measurement that lands after it, and resumes after", async () => {
    await showWorkingRoster();
    await act(async () => {
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("moving");
    await act(async () => {
      roster.rowLayout?.();
      roster.scroll.onScrollBeginDrag?.({});
      flushMeasurements();
    });
    expect(motion()).toBe("still");
    await act(async () => {
      roster.scroll.onMomentumScrollBegin?.({});
      roster.scroll.onMomentumScrollEnd?.({});
      flushMeasurements();
    });
    expect(motion()).toBe("moving");
  });
});

it("ignores a layout change while the roster scrolls", async () => {
  face.items = [
    {
      item: {
        type: "notification",
        ledgerTask: {
          taskId: "busy",
          taskVersion: 1,
          status: "running",
          createdAt: at,
          updatedAt: at,
        },
      },
    },
  ];
  roster.scrollRect = [0, 100, 400, 600];
  roster.rowRect = [0, 120, 400, 64];
  roster.pending.length = 0;
  try {
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MobileBotRosterView
          bots={[{ kind: "main", profile: null }]}
          slackEnabled={false}
          onOpenBot={() => {}}
        />,
      ),
    );
    const motion = () => container.querySelector("[data-motion]")?.getAttribute("data-motion");
    await act(async () => {
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("moving");
    await act(async () => {
      roster.scroll.onScrollBeginDrag?.({});
      roster.rowLayout?.();
      flushMeasurements();
    });
    expect(motion()).toBe("still");
    await act(async () => {
      roster.scroll.onScrollEndDrag?.({ nativeEvent: { velocity: { x: 0, y: 0 } } });
      flushMeasurements();
    });
    expect(motion()).toBe("moving");
  } finally {
    face.items = [];
  }
});

it("offers New bot, a member's own row, and the hidden and deleted bots when the server has members", async () => {
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
  const research = profile("research", "Research");
  const quiet = profile("quiet", "Quiet", { hidden: true });
  const gone = profile("gone", "Gone", { state: "deleted" });
  const open = vi.fn();
  const newBot = vi.fn();
  const restoreDeleted = vi.fn();
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[
          { kind: "main", profile: null },
          { kind: "member", profile: research },
        ]}
        slackEnabled={false}
        selectedKey="bot:research"
        onOpenBot={open}
        members={{
          hidden: [quiet],
          deleted: [gone],
          canCreate: true,
          onNewBot: newBot,
          onLongPressBot: () => {},
          canRestore: true,
          onRestoreDeleted: restoreDeleted,
        }}
      />,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(label),
    );
  expect(button("Research")?.getAttribute("aria-pressed")).toBe("true");
  expect(button("Research")?.getAttribute("aria-label")).toBe("2 waiting for you, Research");
  // A member without an emoji shows its initial, so it is told apart from the main bot's face.
  expect(button("Research")?.querySelector("[data-picture]")?.getAttribute("data-picture")).toBe(
    "R",
  );
  expect(container.textContent).not.toContain("Coming soon");
  await act(async () => button("New bot")?.click());
  expect(newBot).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Quiet");
  await act(async () => button("Hidden bots (1)")?.click());
  await act(async () => button("Quiet")?.click());
  expect(open).toHaveBeenCalledWith({ kind: "member", profile: quiet });
  // A deleted bot opens its archived conversation; Restore is its own button so VoiceOver reaches it.
  const deletedRow = button("Gone");
  expect(deletedRow?.textContent).toContain("Deleted");
  expect(deletedRow?.textContent).not.toContain("Restore");
  await act(async () => deletedRow?.click());
  expect(open).toHaveBeenLastCalledWith({ kind: "member", profile: gone });
  const restore = container.querySelector<HTMLButtonElement>('button[aria-label="Restore Gone"]');
  expect(restore?.textContent).toBe("Restore");
  // A 44pt touch target in both directions, like the other GOAT Bot row buttons.
  expect(restore?.getAttribute("data-class")?.split(" ")).toEqual(
    expect.arrayContaining(["min-h-[44px]", "min-w-[44px]"]),
  );
  await act(async () => restore?.click());
  expect(restoreDeleted).toHaveBeenCalledWith(gone);
  expect(open).toHaveBeenCalledTimes(2);
});

it("offers no restore on a deleted bot to someone who cannot manage bots", async () => {
  const gone = decodeProfile({
    botId: "gone",
    role: "member",
    name: "Gone",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-gone",
    createdAt: at,
    updatedAt: at,
    state: "deleted",
  });
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        slackEnabled={false}
        onOpenBot={() => {}}
        members={{
          hidden: [],
          deleted: [gone],
          canCreate: false,
          onNewBot: () => {},
          onLongPressBot: () => {},
          canRestore: false,
          onRestoreDeleted: () => {},
        }}
      />,
    ),
  );
  const deletedRow = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Gone"),
  );
  expect(deletedRow).toBeDefined();
  expect(container.querySelector('button[aria-label="Restore Gone"]')).toBeNull();
  expect(container.textContent).not.toContain("Restore");
});
it("gives each member row its latest message, unread mark and state in one spoken label", async () => {
  const member = (botId: string, name: string, purpose = "") =>
    decodeProfile({
      botId,
      role: "member",
      name,
      avatar: null,
      purpose,
      defaultModelSelection: null,
      defaultProjectId: null,
      environmentId: "env",
      sessionThreadId: `thread-${botId}`,
      createdAt: at,
      updatedAt: at,
    });
  members.status = {
    scout: {
      waitingCount: 1,
      latest: { text: "**Which** branch should I use?", at, author: "bot" },
      unread: true,
    },
    writer: {
      waitingCount: 0,
      latest: { text: "Draft the release notes", at, author: "person" },
      unread: false,
    },
    fresh: { waitingCount: 0, unread: false },
  };
  try {
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MobileBotRosterView
          bots={[
            { kind: "main", profile: null },
            { kind: "member", profile: member("scout", "Scout") },
            { kind: "member", profile: member("writer", "Writer") },
            { kind: "member", profile: member("fresh", "Fresh", "Watches the disks") },
          ]}
          slackEnabled={false}
          onOpenBot={() => {}}
        />,
      ),
    );
    const row = (name: string) =>
      [...container.querySelectorAll("button")].find((element) =>
        element.getAttribute("aria-label")?.split(", ").includes(name),
      );
    // The second line is the newest message as plain words; the person's own is marked as theirs.
    expect(row("Scout")?.textContent).toContain("Which branch should I use?");
    expect(row("Scout")?.getAttribute("aria-label")).toBe(
      "1 waiting for you, Scout, unread, Which branch should I use?",
    );
    expect(row("Writer")?.textContent).toContain("You: Draft the release notes");
    expect(row("Writer")?.getAttribute("aria-label")).toBe("Writer, You: Draft the release notes");
    // A bot that has not talked yet shows what it is for.
    expect(row("Fresh")?.textContent).toContain("Watches the disks");
    expect(row("Fresh")?.getAttribute("aria-label")).toBe("Fresh, Watches the disks");
  } finally {
    members.status = {};
  }
});

it("where Home governs, a row shows and says its unread recent tasks and what it cannot read", async () => {
  signals.byBot = {
    main: {
      unread: 3,
      missing: null,
      spoken: ["3 unread tasks; recent work only; older work may be missing"],
    },
    scout: {
      unread: null,
      missing: "Unread and waiting unavailable",
      spoken: ["Unread and waiting unavailable"],
    },
  };
  // Scout's last status read failed; the count it answered before is no longer known.
  members.status = { scout: { waitingCount: 1, unread: false, waitingState: "unavailable" } };
  try {
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <MobileBotRosterView
          bots={[
            { kind: "main", profile: null },
            {
              kind: "member",
              profile: decodeProfile({
                botId: "scout",
                role: "member",
                name: "Scout",
                avatar: null,
                purpose: "",
                defaultModelSelection: null,
                defaultProjectId: null,
                environmentId: "env",
                sessionThreadId: "thread-scout",
                createdAt: at,
                updatedAt: at,
              }),
            },
          ]}
          slackEnabled={false}
          onOpenBot={() => {}}
        />,
      ),
    );
    const row = (name: string) =>
      [...container.querySelectorAll("button")].find((element) =>
        element.getAttribute("aria-label")?.split(", ").includes(name),
      );
    expect(row("GOAT Bot")?.getAttribute("aria-label")).toContain(
      "3 unread tasks; recent work only; older work may be missing",
    );
    expect(row("GOAT Bot")?.textContent).toContain("3");
    expect(row("Scout")?.getAttribute("aria-label")).toBe("Scout, Unread and waiting unavailable");
    expect(row("Scout")?.textContent).toBe("Scout–");
  } finally {
    signals.byBot = {};
    members.status = {};
  }
});
