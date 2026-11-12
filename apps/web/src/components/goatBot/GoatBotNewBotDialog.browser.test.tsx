import { BotProfile, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

const server = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  failFirst: true,
  capabilities: {} as Record<string, boolean>,
}));
const created = vi.hoisted(() => ({ bot: null as unknown }));

/** Resets what the mocks read, so each test starts from its own server. */
function setup(capabilities: Record<string, boolean> = {}) {
  server.inputs = [];
  server.updates = [];
  server.failFirst = true;
  server.capabilities = capabilities;
}

vi.mock("~/state/channels", () => ({
  channelEnvironment: { createBot: "createBot", updateBot: "updateBot" },
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ serverConfig: { environment: { capabilities: server.capabilities } } }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: string) =>
    async ({ input }: { input: Record<string, unknown> }) => {
      if (command === "updateBot") {
        server.updates.push(input);
        const { botId: _botId, ...changes } = input;
        return { _tag: "Success", value: { bot: { ...(created.bot as object), ...changes } } };
      }
      server.inputs.push(input);
      if (server.failFirst && server.inputs.length === 1)
        return { _tag: "Failure", cause: new Error("Connection lost") };
      return { _tag: "Success", value: { bot: created.bot } };
    },
}));
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("./useGoatBotModel", () => ({
  useGoatBotModel: () => ({
    selection: { instanceId: "codex", model: "gpt-main" },
    entries: [],
    options: new Map(),
  }),
}));
// The real picker needs the provider catalog; this stand-in picks one model.
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerAriaLabel: string;
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button type="button" onClick={() => props.onInstanceModelChange("codex", "gpt-small")}>
      {props.triggerAriaLabel}
    </button>
  ),
}));

import { GoatBotNewBotDialog } from "./GoatBotNewBotDialog";

const decodeProfile = Schema.decodeSync(BotProfile);
const research = () =>
  decodeProfile({
    botId: "research",
    role: "member",
    name: "Research",
    avatar: "🔎",
    purpose: "Find sources",
    defaultModelSelection: { instanceId: "codex", model: "gpt-small" },
    defaultProjectId: null,
    environmentId: "env-1",
    sessionThreadId: "thread-research",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });

it("creates a bot with its model and keeps one request id when a save is retried", async () => {
  setup();
  created.bot = research();
  const onCreated = vi.fn();
  const pending: Array<string | null> = [];
  await using _screen = await render(
    <GoatBotNewBotDialog
      environmentId={EnvironmentId.make("env-1")}
      canSubmit
      onCreated={onCreated}
      onPending={(name) => pending.push(name)}
      onClose={() => undefined}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Research");
  await userEvent.fill(page.getByRole("textbox", { name: "Avatar" }), "🔎");
  // Purpose and model wait under More, so a bot needs only a name and a look.
  expect(page.getByRole("textbox", { name: "Purpose" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "More" }));
  await expect.element(page.getByText("Same as GOAT Bot")).toBeVisible();
  await userEvent.fill(page.getByRole("textbox", { name: "Purpose" }), "Find sources");
  await userEvent.click(page.getByRole("button", { name: "New bot model: gpt-main" }));
  await userEvent.click(page.getByRole("button", { name: "Create" }));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
  await userEvent.click(page.getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created.bot));
  // The failed try clears its row; the successful one leaves it for the list to retire.
  expect(pending).toEqual(["Research", null, "Research"]);
  expect(server.inputs).toHaveLength(2);
  expect(server.inputs[0]).toMatchObject({
    name: "Research",
    avatar: "🔎",
    purpose: "Find sources",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-small" },
  });
  expect(server.inputs[1]?.clientRequestId).toBe(server.inputs[0]?.clientRequestId);
  // Nothing changed between the tries, so the bot the server kept needs no change.
  expect(server.updates).toEqual([]);
});

it("sends edits made after a failed try as a change, when the server kept the first create", async () => {
  setup({ goatBotMemberModelEdit: true });
  // The server stored the first try; a retry with its request id returns that bot as it was.
  created.bot = research();
  const onCreated = vi.fn();
  await using _screen = await render(
    <GoatBotNewBotDialog
      environmentId={EnvironmentId.make("env-1")}
      canSubmit
      onCreated={onCreated}
      onClose={() => undefined}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Research");
  await userEvent.fill(page.getByRole("textbox", { name: "Avatar" }), "🔎");
  await userEvent.click(page.getByRole("button", { name: "More" }));
  await userEvent.fill(page.getByRole("textbox", { name: "Purpose" }), "Find sources");
  await userEvent.click(page.getByRole("button", { name: "New bot model: gpt-main" }));
  await userEvent.click(page.getByRole("button", { name: "Create" }));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Research desk");
  await userEvent.click(page.getByRole("button", { name: "Create" }));
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  expect(server.inputs[1]?.clientRequestId).toBe(server.inputs[0]?.clientRequestId);
  expect(server.updates).toEqual([{ botId: "research", name: "Research desk" }]);
  expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ botId: "research", name: "Research desk" });
});
