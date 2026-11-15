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
  /** When set, the server answers by the bot each read asks for, as channel.listTasks does. */
  tasksByBot: null as Record<string, unknown[]> | null,
  /** Each computer's goatBotMembers capability; a computer missing here has no config yet. */
  members: {} as Record<string, boolean>,
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listTasks: (target: unknown) => {
      state.requested(target);
      return target;
    },
  },
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: (environmentId: string | null) =>
    environmentId === null || state.members[environmentId] === undefined
      ? null
      : { environment: { capabilities: { goatBotMembers: state.members[environmentId] } } },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { input?: { botId?: string } } | null) => ({
    data:
      atom === null
        ? null
        : state.tasksByBot === null
          ? state.data
          : {
              tasks:
                atom.input?.botId === undefined
                  ? Object.values(state.tasksByBot).flat()
                  : (state.tasksByBot[atom.input.botId] ?? []),
            },
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
  openQuestions: [] as unknown[],
  ...(worker === undefined ? {} : { worker }),
});
function setup(data: unknown, cause: unknown = null) {
  state.data = data;
  state.cause = cause;
  state.tasksByBot = null;
  // A known older server, unless a test says otherwise.
  state.members = { env: false };
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

it("says what a machine's task waits on the person for, as Home does", async () => {
  setup({
    tasks: [
      { ...task("a", "Pick a disk", {}), openQuestions: [{ questionId: "q" }] },
      task("b", "Keep building", {}),
    ],
  });
  await render();
  const text = container.textContent ?? "";
  expect(text).toContain("Pick a diskWaiting for your answer");
  expect(text).toContain("Keep buildingWorking");
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
  // A member is named whether or not the computer's config has arrived.
  state.members = {};
  await render({ botId: BotId.make("research") });
  expect(state.requested).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "research" }),
  });
});

it("the main bot's card lists only the main bot's work on a server with member bots", async () => {
  setup(null);
  state.members = { env: true };
  state.tasksByBot = {
    main: [task("a", "Move the build to Node 24", {})],
    scout: [task("b", "Pick the release branch", {})],
  };
  await render();
  expect(container.textContent).toContain("Move the build to Node 24");
  expect(container.textContent).not.toContain("Pick the release branch");
});

it("the main bot's card asks for nothing until the computer's config is known, then for the main bot only (#3333)", async () => {
  setup(null);
  state.members = {};
  state.tasksByBot = {
    main: [task("a", "Move the build to Node 24", {})],
    scout: [task("b", "Pick the release branch", {})],
  };
  await render();
  expect(state.requested).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Machines can't be listed from this server right now.");
  expect(container.textContent).not.toContain("Pick the release branch");
  state.members = { env: true };
  await render();
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "main" }),
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Move the build to Node 24");
  expect(container.textContent).not.toContain("Pick the release branch");
});

it("an older server without member bots is asked as before, without a bot", async () => {
  setup(null);
  state.members = { env: false };
  state.tasksByBot = { main: [task("a", "Move the build to Node 24", {})] };
  await render();
  expect(container.textContent).toContain("Move the build to Node 24");
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId,
    input: expect.not.objectContaining({ botId: expect.anything() }),
  });
});

it("follows the computer shown: main is named only where that computer has member bots", async () => {
  setup(null);
  state.tasksByBot = { main: [], scout: [] };
  const older = EnvironmentId.make("older");
  state.members = { env: true, older: false };
  await render();
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "main" }),
  });
  await render({ environmentId: older });
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId: older,
    input: expect.not.objectContaining({ botId: expect.anything() }),
  });
  await render({ environmentId });
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "main" }),
  });
});

it("reads the machines again when the bot's work changes while Home is open", async () => {
  setup({ tasks: [] });
  await render({ workKey: "t1:running" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ workKey: "t1:running" });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await render({ workKey: "t1:completed" });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
