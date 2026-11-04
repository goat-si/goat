import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotThreadRow } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ update: vi.fn(async () => {}), alert: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Alert: { alert: state.alert },
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({ rows: [] }) }));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: [],
    children: { rows: [], hasMore: false },
    slackEnabled: false,
    update: state.update,
    showMore: () => {},
    error: null,
  }),
}));
vi.mock("./MobileBotRosterView", () => ({
  MobileBotRosterView: (props: { onLongPressTask: (row: typeof task) => void }) => (
    <button onClick={() => props.onLongPressTask(task)}>Menu</button>
  ),
}));
import { MobileBotRoster } from "./MobileBotRosterPanel";
const at = "2026-11-04T10:00:00.000Z";
const task = Schema.decodeUnknownSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "task", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
});
it("sends reversible view changes and read-through from the task menu", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} onOpenChild={() => {}} />),
  );
  await act(async () => container.querySelector("button")?.click());
  const actions = state.alert.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
  await act(async () => {
    actions[0]?.onPress?.();
    actions[1]?.onPress?.();
    actions[2]?.onPress?.();
  });
  expect(state.update.mock.calls).toEqual([
    [{ taskId: "task", pinned: true }],
    [{ taskId: "task", done: true }],
    [{ taskId: "task", readThrough: at }],
  ]);
  await act(async () => root.unmount());
});
