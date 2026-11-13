import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BotId, EnvironmentId } from "@goat/contracts";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
const state = vi.hoisted(() => ({
  data: null as unknown,
  cause: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listTasks: (target: unknown) => {
      state.requested(target);
      return "tasks";
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    cause: atom === null ? null : state.cause,
    error: null,
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
import { MobileBotComputer } from "./MobileBotComputer";

const environmentId = EnvironmentId.make("env");
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});
const task = (taskId: string, title: string, worker?: { host?: string }) => ({
  taskId,
  title,
  status: "running",
  updatedAt: "2026-11-07T10:00:00.000Z",
  ...(worker === undefined ? {} : { worker }),
});
function setup(data: unknown, cause: unknown = null) {
  state.data = data;
  state.cause = cause;
  state.refresh.mockReset();
  state.requested.mockReset();
}
type Props = Partial<Parameters<typeof MobileBotComputer>[0]>;
async function render(props: Props = {}) {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotComputer environmentId={environmentId} connected botId={null} {...props} />,
    ),
  );
}

it("lists running work under the machine it runs on, GOAT Bot's own first", async () => {
  setup({
    tasks: [task("a", "Fix the build", { host: "studio" }), task("b", "Summarize the inbox", {})],
  });
  await render();
  const text = container.textContent ?? "";
  expect(text.indexOf("GOAT Bot's computer")).toBeLessThan(text.indexOf("Summarize the inbox"));
  expect(text.indexOf("Summarize the inbox")).toBeLessThan(text.indexOf("studio"));
  expect(text.indexOf("studio")).toBeLessThan(text.indexOf("Fix the build"));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("says when nothing runs, when the list is cut short, and offline", async () => {
  setup({ tasks: [] });
  await render();
  expect(container.textContent).toContain("No work running");
  expect(container.textContent).toContain("Machines GOAT Bot works on will appear here.");
  setup({ tasks: [task("a", "Fix the build", {})], nextCursor: "more" });
  await render();
  expect(container.textContent).toContain("More tasks are running than this list shows.");
  await render({ connected: false });
  expect(container.textContent).toContain("Machines are unavailable while GOAT Bot is offline.");
});

it("a failure can be tried again", async () => {
  setup(null, new Error("socket"));
  await render();
  expect(container.textContent).toContain("Couldn't load GOAT Bot's machines.");
  state.refresh.mockClear();
  const again = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Try again",
  );
  await act(async () => again?.click());
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("shows a denied read without offering a retry", async () => {
  setup(null, { _tag: "EnvironmentAuthorizationError" });
  await render();
  expect(container.textContent).toContain("This device can't read GOAT Bot's machines.");
  expect(container.textContent).not.toContain("Try again");
});

it("a member's tab lists only that bot's work", async () => {
  setup({ tasks: [] });
  await render({ botId: BotId.make("research") });
  expect(state.requested).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "research" }),
  });
});

it("reads the machines again when the bot's work changes while Home is open", async () => {
  await render({ workKey: "t1:running" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ workKey: "t1:running" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ workKey: "t1:completed" });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
