import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { selected?: boolean };
  }) => (
    <button onClick={onPress} disabled={disabled} aria-pressed={accessibilityState?.selected}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled }: { label: string; disabled?: boolean }) => (
    <button disabled={disabled}>{label}</button>
  ),
}));
import { MobileBotRosterView, MobileHomeSegments } from "./MobileBotRosterView";

const at = "2026-11-04T10:00:00.000Z";
const task = Schema.decodeUnknownSync(BotThreadRow)({
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
  expect(container.textContent).toContain("waiting input");
  expect(container.textContent).toContain("Show more");
  expect(container.querySelector("button:disabled")?.textContent).toContain("Coming soon");
  const taskButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Review"),
  );
  await act(async () => taskButton?.click());
  expect(open).toHaveBeenCalledWith(task);
});
