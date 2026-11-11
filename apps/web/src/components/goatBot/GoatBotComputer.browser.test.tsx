import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  data: null as unknown,
  failure: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
  revision: 0,
  supportsChanges: false,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ _tag: "Success", value: { revision: state.revision }, waiting: false }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { goatBotTaskChanges: state.supportsChanges } } },
  }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    taskChanges: () => "changes",
    listTasks: (target: unknown) => {
      state.requested(target);
      return "tasks";
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    failure: state.failure,
    error: state.failure === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotComputer } from "./GoatBotComputer";

const environmentId = EnvironmentId.make("env");
const decodeProfile = Schema.decodeSync(BotProfile);
const task = (taskId: string, title: string, worker?: { host?: string }) => ({
  taskId,
  title,
  status: "running",
  updatedAt: "2026-11-07T10:00:00.000Z",
  ...(worker === undefined ? {} : { worker }),
});
function setup(data: unknown, failure: unknown = null) {
  state.revision = 0;
  state.supportsChanges = false;
  state.data = data;
  state.failure = failure;
  state.refresh.mockReset();
  state.requested.mockReset();
}

it("lists running work under the machine it runs on, GOAT Bot's own first", async () => {
  setup({
    tasks: [task("a", "Fix the build", { host: "studio" }), task("b", "Summarize the inbox", {})],
  });
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  const text = screen.container.textContent ?? "";
  expect(text.indexOf("GOAT Bot's computer")).toBeLessThan(text.indexOf("studio"));
  expect(text.indexOf("Summarize the inbox")).toBeLessThan(text.indexOf("studio"));
  expect(text.indexOf("studio")).toBeLessThan(text.indexOf("Fix the build"));
  expect(state.requested).toHaveBeenCalledWith({
    environmentId,
    input: { status: ["received", "dispatching", "running", "waiting_input"], limit: 100 },
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("says when nothing is running", async () => {
  setup({ tasks: [] });
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect.element(screen.getByText("No work running")).toBeVisible();
});

it("says when more work runs than the list shows", async () => {
  setup({ tasks: [task("a", "Fix the build", {})], nextCursor: "more" });
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect
    .element(screen.getByText("More tasks are running than this list shows."))
    .toBeVisible();
});

it("a failure can be tried again", async () => {
  setup(null, new Error("socket"));
  state.supportsChanges = true;
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect.element(screen.getByText("Couldn't load GOAT Bot's machines.")).toBeVisible();
  state.refresh.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("a member's tab lists only that bot's work", async () => {
  setup({ tasks: [] });
  const member = decodeProfile({
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-research",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });
  await using _screen = await render(
    <GoatBotMemberContext value={member}>
      <GoatBotComputer environmentId={environmentId} />
    </GoatBotMemberContext>,
  );
  expect(state.requested).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "research" }),
  });
});

it("rereads on task revisions without remounting the retry button", async () => {
  setup(null, new Error("socket"));
  state.supportsChanges = true;
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  const button = screen.getByRole("button", { name: "Try again" });
  await userEvent.click(button);
  state.refresh.mockClear();
  state.revision = 1;
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await expect.element(button).toHaveFocus();
});

it("rereads on window focus when task subscriptions are unavailable", async () => {
  setup({ tasks: [] });
  await using _screen = await render(<GoatBotComputer environmentId={environmentId} />);
  state.refresh.mockClear();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
});
