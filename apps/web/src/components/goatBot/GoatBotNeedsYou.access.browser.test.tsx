import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

vi.unmock("./useGoatBotComputerReadable");

type Failure = { kind: "blocked" | "retrying"; reason: string; detail: string };
const state = vi.hoisted(() => ({
  connection: { phase: "connected" } as { phase: string; failure?: Failure },
  listed: true,
  navigate: vi.fn(),
  // Stable, as a query's kept answer is; Needs you keeps it in state when it changes.
  asks: {
    asks: [
      {
        botId: "main",
        taskId: "task-1",
        kind: "approval",
        text: "Approve the deploy?",
        askedAt: "2026-11-10T00:00:00.000Z",
      },
    ],
    total: 1,
    truncated: false,
  },
  refresh: () => {},
}));
vi.mock("@effect/atom-react", async (original) => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("@effect/atom-react")>()),
    useAtomValue: (atom: unknown) =>
      atom === "permission"
        ? true
        : AsyncResult.success({ subscription: 1, value: { revision: 0 } }),
  };
});
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () =>
    state.listed
      ? {
          connection: state.connection,
          serverConfig: {
            environment: {
              capabilities: {
                goatBotOpenAsks: true,
                goatBotOpenAsksLimit: true,
                goatBotTaskChanges: true,
              },
            },
          },
        }
      : null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/environments/primary/sessionCheck", () => ({
  primarySessionCheck: { subscribe: () => () => {}, revoked: () => false },
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    taskChanges: () => "changes",
    taskChangesPermission: () => "permission",
    listOpenAsksPermission: () => "permission",
    listOpenAsks: () => "asks",
  },
}));
vi.mock("~/state/query", () => ({
  // A refused or dropped read keeps its last answer, as useEnvironmentQuery does.
  useEnvironmentQuery: () => ({ data: state.asks, error: null, refresh: state.refresh }),
}));
vi.mock("~/components/RelativeTimeLabel", () => ({ RelativeTimeLabel: () => <span>1h</span> }));
import { GoatBotNeedsYou } from "./GoatBotNeedsYou";
import { dispatchMenuAction } from "~/shortcuts/dispatcher";

const bots = [{ botId: "main", name: "Helper" }] as unknown as React.ComponentProps<
  typeof GoatBotNeedsYou
>["bots"];
const view = () => (
  <GoatBotNeedsYou environmentId={EnvironmentId.make("env")} bots={bots} visible />
);

function setup(connection: { phase: string; failure?: Failure }, listed = true) {
  state.connection = connection;
  state.listed = listed;
  state.navigate.mockReset();
}

it.each([
  [
    "refuses this client's credential",
    { phase: "error", failure: { kind: "blocked", reason: "authentication", detail: "Refused" } },
    true,
  ],
  [
    "refuses this client's scope",
    { phase: "reconnecting", failure: { kind: "blocked", reason: "permission", detail: "Scope" } },
    true,
  ],
] as const)(
  "Needs you shows no kept asks and the next-ask command opens none while its computer %s",
  async (_case, connection, listed) => {
    setup(connection, listed);
    await using screen = await render(view());
    expect(screen.container.textContent).toBe("");
    await act(() => dispatchMenuAction("goatBot.nextAsk"));
    expect(state.navigate).not.toHaveBeenCalled();
  },
);

it("guard: Needs you shows nothing for a computer removed from the app", async () => {
  setup({ phase: "connected" }, false);
  await using screen = await render(view());
  expect(screen.container.textContent).toBe("");
  await act(() => dispatchMenuAction("goatBot.nextAsk"));
  expect(state.navigate).not.toHaveBeenCalled();
});

it("guard: Needs you keeps its asks and next ask while its computer cannot be reached", async () => {
  setup({
    phase: "reconnecting",
    failure: { kind: "retrying", reason: "host-unreachable", detail: "Unreachable" },
  });
  await using screen = await render(view());
  await expect.element(screen.getByText(/Approve the deploy\?/)).toBeVisible();
  await act(() => dispatchMenuAction("goatBot.nextAsk"));
  expect(state.navigate).toHaveBeenCalledWith({ to: "/bot", search: { task: "task-1" } });
});
