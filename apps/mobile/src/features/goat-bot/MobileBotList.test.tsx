import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigationState: (select: (state: object) => unknown) =>
    select({ index: 0, routes: [{ name: "Home" }] }),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => state.select,
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ known: true, mode: "bot", setMode: vi.fn() }),
}));
vi.mock("./MobileBotRosterView", () => ({ MobileHomeSegments: () => <div>Bots | Threads</div> }));
vi.mock("./MobileBotRosterPanel", () => ({
  MobileBotRoster: (props: { onOpenBot: () => void; onOpenChild: (row: object) => void }) => (
    <div>
      <button onClick={props.onOpenBot}>GOAT Bot Main</button>
      <button onClick={() => props.onOpenChild({ kind: "task", task: { taskId: "task-1" } })}>
        Task
      </button>
      <button
        onClick={() =>
          props.onOpenChild({ kind: "coding", environmentId: "env", threadId: "thread" })
        }
      >
        Coding
      </button>
    </div>
  ),
}));
import { MobileBotList } from "./MobileBotList";

it("opens the main bot, task, and coding thread from the bot list", async () => {
  state.select.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotList />));
  expect(container.textContent).toContain("GOAT Bot Main");
  for (const button of container.querySelectorAll("button")) await act(async () => button.click());
  expect(state.select.mock.calls).toEqual([
    [{ name: "GoatBot", params: {} }],
    [{ name: "GoatBot", params: { taskId: "task-1" } }],
    [{ name: "Thread", params: { environmentId: "env", threadId: "thread" } }],
  ]);
  await act(async () => root.unmount());
});
