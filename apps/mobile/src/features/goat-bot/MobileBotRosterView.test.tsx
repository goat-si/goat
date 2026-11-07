import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  Alert: { alert: vi.fn() },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityState,
    accessibilityLabel,
    onAccessibilityAction,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean; expanded?: boolean };
    accessibilityLabel?: string;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-pressed={accessibilityState?.selected}
      aria-expanded={accessibilityState?.expanded}
      aria-label={accessibilityLabel}
      onKeyDown={(event) => onAccessibilityAction?.({ nativeEvent: { actionName: event.key } })}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => <span /> }));
const face = vi.hoisted(() => ({ items: [] as ReadonlyArray<object> }));
vi.mock("./GoatBotFace", () => ({ GoatBotFaceAvatar: () => <span /> }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "bot" } }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => face.items,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => <span /> }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled }: { label: string; disabled?: boolean }) => (
    <button disabled={disabled}>{label}</button>
  ),
}));
import { MobileBotRosterView, MobileHomeSegments } from "./MobileBotRosterView";

const at = "2026-11-04T10:00:00.000Z";
const decodeRow = Schema.decodeUnknownSync(BotThreadRow);
const task = decodeRow({
  kind: "task",
  task: { taskId: "task", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
});
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

it("renders the main bot, child task and disabled creation action", async () => {
  const open = vi.fn();
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        rows={[task]}
        hasMore
        hiddenCount={2}
        slackEnabled
        preview="Latest reply"
        unread
        onOpenBot={() => {}}
        onOpenChild={open}
        onLongPressTask={() => {}}
        onShowMore={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("GOAT Bot  ·  Main  ·  Slack");
  expect(container.textContent).toContain("Review");
  expect(container.textContent).toContain("Needs your input");
  expect(container.textContent).toContain("Show more");
  expect(container.querySelector("button:disabled")?.textContent).toContain("Coming soon");
  const taskButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Review"),
  );
  await act(async () => taskButton?.click());
  expect(open).toHaveBeenCalledWith(task);
});

it("shows Done for a task marked done", async () => {
  if (task.kind !== "task") throw new Error("Expected a task");
  const done = { ...task, view: { ...task.view, doneAt: at } };
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        rows={[done]}
        hasMore={false}
        slackEnabled={false}
        onOpenBot={() => {}}
        onOpenChild={() => {}}
        onLongPressTask={() => {}}
        onShowMore={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("Done");
  expect(container.querySelector('[aria-label="Review, Done, unread"]')).not.toBeNull();
});

it("shows roster empty copy only without child rows", async () => {
  const props = {
    bots: [{ kind: "main" as const, profile: null }],
    hasMore: false,
    slackEnabled: false,
    onOpenBot: () => {},
    onOpenChild: () => {},
    onLongPressTask: () => {},
    onShowMore: () => {},
  };
  root = createRoot(container);
  await act(async () => root?.render(<MobileBotRosterView {...props} rows={[]} />));
  expect(container.textContent).toContain("Work GOAT Bot starts will appear here.");
  await act(async () => root?.render(<MobileBotRosterView {...props} rows={[task]} />));
  expect(container.textContent).not.toContain("Work GOAT Bot starts will appear here.");
});

it("exposes task actions and expands and collapses hidden rows", async () => {
  const action = vi.fn();
  function Harness() {
    const [expanded, setExpanded] = React.useState(false);
    return (
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        rows={[task]}
        hasMore={!expanded}
        expanded={expanded}
        hiddenCount={2}
        slackEnabled={false}
        onOpenBot={() => {}}
        onOpenChild={() => {}}
        onLongPressTask={() => {}}
        onTaskAction={action}
        onShowMore={() => setExpanded(!expanded)}
      />
    );
  }
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Review"),
  );
  await act(async () =>
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "read", bubbles: true })),
  );
  expect(action).toHaveBeenCalledWith(task, "read");
  const more = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Show more"),
  );
  expect(more?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => more?.click());
  expect(more?.textContent).toContain("Show less");
  expect(more?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => more?.click());
  expect(more?.textContent).toContain("Show more (2)");
});

it("marks the selected coding thread with its own status", async () => {
  const coding = decodeRow({
    kind: "coding",
    taskId: "task",
    environmentId: "env",
    threadId: "thread",
    title: "Code",
    state: "bound",
    lastActivityAt: at,
  });
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotRosterView
        bots={[{ kind: "main", profile: null }]}
        rows={[coding]}
        hasMore={false}
        slackEnabled={false}
        selectedKey="coding:env:thread"
        codingStatuses={new Map([["coding:env:thread", "working"]])}
        onOpenBot={() => {}}
        onOpenChild={() => {}}
        onLongPressTask={() => {}}
        onShowMore={() => {}}
      />,
    ),
  );
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Code"),
  );
  expect(row?.getAttribute("aria-label")).toBe("Code, Working");
  expect(row?.getAttribute("aria-pressed")).toBe("true");
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
          rows={[]}
          hasMore={false}
          slackEnabled={false}
          onOpenBot={() => {}}
          onOpenChild={() => {}}
          onLongPressTask={() => {}}
          onShowMore={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="GOAT Bot, Waiting for you"]')).not.toBeNull();
  } finally {
    face.items = [];
  }
});
