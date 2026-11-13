import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  hidden: false,
  connections: [] as ReadonlyArray<{ enabled: boolean }>,
  slackSupported: true,
  connected: true,
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (selector: (settings: { goatBotSuggestedHidden: boolean }) => unknown) =>
    selector({ goatBotSuggestedHidden: state.hidden }),
  persistClientSettingsPatch: (patch: Record<string, unknown>) => {
    state.patches.push(patch);
    if (patch.goatBotSuggestedHidden !== undefined)
      state.hidden = patch.goatBotSuggestedHidden as boolean;
    return Promise.resolve();
  },
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: { environment: { capabilities: { slackChannel: state.slackSupported } } },
  }),
}));
vi.mock("~/state/channels", () => ({ channelEnvironment: { slackSettings: () => "slack" } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.connections,
    failure: null,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));

import { GoatBotSuggested } from "./GoatBotSuggested";

const environmentId = EnvironmentId.make("env");

function setup(connections: ReadonlyArray<{ enabled: boolean }> = []) {
  state.hidden = false;
  state.connections = connections;
  state.slackSupported = true;
  state.connected = true;
  state.patches = [];
}

const view = () => <GoatBotSuggested environmentId={environmentId} />;

it("offers one Connect Slack row while Slack is supported and no channel is connected", async () => {
  setup();
  await using screen = await render(view());
  await expect.element(screen.getByRole("heading", { name: "Suggested" })).toBeVisible();
  await expect.element(screen.getByText("Connect Slack")).toBeVisible();
  expect(screen.getByRole("link", { name: "Connect Slack" }).element()).toHaveAttribute(
    "href",
    expect.stringContaining("slack-channel"),
  );
  // The whole row is the link, so its title and description open it too.
  const link = screen.getByRole("link", { name: "Connect Slack" });
  await expect.element(link.getByText("Talk to this bot from Slack")).toBeVisible();
});

it("says nothing once a Slack channel is connected", async () => {
  setup([{ enabled: true }]);
  await using screen = await render(view());
  expect(screen.container.textContent).not.toContain("Connect Slack");
});

it("says nothing where the server does not support Slack", async () => {
  setup();
  state.slackSupported = false;
  await using screen = await render(view());
  expect(screen.container.textContent).not.toContain("Connect Slack");
});

it("hides the suggestion for this device, and Settings brings it back", async () => {
  setup();
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(state.patches).toEqual([{ goatBotSuggestedHidden: true }]);
  // The store is a stand-in here, so the rerender it would cause is explicit.
  await screen.rerender(view());
  await expect.element(screen.getByRole("heading", { name: "Suggested" })).not.toBeInTheDocument();
  // The reverse state: the setting is the only way back, and it shows the row again.
  state.hidden = false;
  await screen.rerender(view());
  await expect.element(screen.getByText("Connect Slack")).toBeVisible();
});

it("stays hidden where the person already hid it", async () => {
  setup();
  state.hidden = true;
  await using screen = await render(view());
  expect(screen.container.textContent).not.toContain("Connect Slack");
});
