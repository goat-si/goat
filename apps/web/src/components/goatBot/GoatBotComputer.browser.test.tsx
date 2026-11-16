import { BotProfile, EnvironmentAuthorizationError, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  data: null as unknown,
  failure: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
  revision: 0 as number | null | "failed",
  supportsChanges: false,
  permitted: true,
  phase: "connected",
  // "unknown": connected, but the computer's config has not arrived yet.
  config: "older" as "unknown" | "members" | "older",
  scopedFixture: false,
  requestedBot: null as string | null,
}));
vi.mock("@effect/atom-react", async (original) => {
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  return {
    ...(await original<typeof import("@effect/atom-react")>()),
    // null: the stream has not answered yet; "failed": the server refused or ended it.
    useAtomValue: (atom: unknown) =>
      atom === "permission"
        ? state.permitted
        : state.revision === null
          ? AsyncResult.initial(true)
          : state.revision === "failed"
            ? AsyncResult.failure(Cause.die("refused"))
            : AsyncResult.success({ subscription: 1, value: { revision: state.revision } }),
  };
});
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: state.phase },
    serverConfig:
      state.config === "unknown"
        ? null
        : {
            environment: {
              capabilities: {
                goatBotTaskChanges: state.supportsChanges,
                ...(state.config === "members" ? { goatBotMembers: true } : {}),
              },
            },
          },
  }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    taskChanges: () => "changes",
    taskChangesPermission: () => "permission",
    listTasks: (target: unknown) => {
      state.requested(target);
      state.requestedBot = (target as { input: { botId?: string } }).input.botId ?? null;
      return "tasks";
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === null
        ? null
        : state.scopedFixture
          ? {
              tasks: [
                task("main-task", "Main bot work"),
                ...(state.requestedBot === "main" ? [] : [task("other-task", "Member bot work")]),
              ],
            }
          : state.data,
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
  openQuestions: [],
  ...(worker === undefined ? {} : { worker }),
});
function setup(data: unknown, failure: unknown = null) {
  state.revision = 0;
  state.phase = "connected";
  state.config = "older";
  state.scopedFixture = false;
  state.requestedBot = null;
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

it("the main bot's card keeps the loading skeleton while the computer connects with no config, and reads nothing (#3450)", async () => {
  setup(null);
  state.config = "unknown";
  state.phase = "connecting";
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect.element(screen.getByText("Loading machines…")).toBeInTheDocument();
  expect(
    screen.getByText("Machines can't be listed from this server right now.").query(),
  ).toBeNull();
  expect(state.requested).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
  state.phase = "connected";
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  await expect
    .element(screen.getByText("Machines can't be listed from this server right now."))
    .toBeVisible();
  expect(state.requested).not.toHaveBeenCalled();
  expect(state.refresh).not.toHaveBeenCalled();
});

// Regression: Machines said Working while the bot's face said the task waited on the person.
it("says a running task waits for your approval when its worker asks for one", async () => {
  setup({
    tasks: [
      {
        ...task("a", "Deploy the site", {}),
        observed: {
          pullRequests: [],
          needsYou: [{ kind: "approval", since: "2026-11-07T10:00:00.000Z" }],
        },
      },
      task("b", "Tidy the notes", {}),
    ],
  });
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect
    .element(screen.getByRole("listitem").filter({ hasText: "Deploy the site" }))
    .toMatchTextContent(/Waiting for your approval/);
  await expect
    .element(screen.getByRole("listitem").filter({ hasText: "Tidy the notes" }))
    .toMatchTextContent(/Working/);
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
  // A member is named whether or not the computer's config has arrived.
  state.config = "unknown";
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

it("reads again once when the change stream starts tracking, then once per later revision", async () => {
  setup({ tasks: [] });
  state.supportsChanges = true;
  state.revision = null;
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  // Revision 0 is the server's acknowledgement: a change between the first read and it shows now.
  state.revision = 0;
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  expect(state.refresh).toHaveBeenCalledTimes(2);
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  expect(state.refresh).toHaveBeenCalledTimes(2);
  state.revision = 1;
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  expect(state.refresh).toHaveBeenCalledTimes(3);
});

it("reads again on window focus once the server refuses or ends the change stream", async () => {
  setup({ tasks: [] });
  state.supportsChanges = true;
  state.revision = "failed";
  await using _screen = await render(<GoatBotComputer environmentId={environmentId} />);
  state.refresh.mockClear();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
});

it("does not offer retry when the machine list is denied or offline", async () => {
  setup(
    null,
    new EnvironmentAuthorizationError({ message: "no", requiredScope: "orchestration:read" }),
  );
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect
    .element(screen.getByText("This device can't read GOAT Bot's machines."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("does not offer retry while machines are offline", async () => {
  setup(null, new Error("socket"));
  state.phase = "offline";
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect
    .element(screen.getByText("GOAT Bot's machines are unavailable while the computer is offline."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("scopes the main bot to its own work on servers with members", async () => {
  setup(null);
  state.config = "members";
  state.scopedFixture = true;
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  await expect.element(screen.getByText(/Main bot work/)).toBeVisible();
  expect(screen.getByText(/Member bot work/).query()).toBeNull();
  expect(state.requested).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "main" }),
  });
});

it("the main bot's card asks for nothing until the computer's config is known, then for the main bot only (#3423)", async () => {
  setup(null);
  state.config = "unknown";
  state.scopedFixture = true;
  await using screen = await render(<GoatBotComputer environmentId={environmentId} />);
  expect(state.requested).not.toHaveBeenCalled();
  expect(screen.getByText(/Member bot work/).query()).toBeNull();
  expect(state.refresh).not.toHaveBeenCalled();
  await expect
    .element(screen.getByText("Machines can't be listed from this server right now."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
  state.config = "members";
  await screen.rerender(<GoatBotComputer environmentId={environmentId} />);
  await expect.element(screen.getByText(/Main bot work/)).toBeVisible();
  expect(screen.getByText(/Member bot work/).query()).toBeNull();
  expect(state.requested).toHaveBeenLastCalledWith({
    environmentId,
    input: expect.objectContaining({ botId: "main" }),
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
