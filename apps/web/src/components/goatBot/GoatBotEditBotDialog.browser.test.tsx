import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

const server = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  modelEdit: true,
}));

vi.mock("~/state/channels", () => ({ channelEnvironment: { updateBot: {} } }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { goatBotMemberModelEdit: server.modelEdit } } },
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: Record<string, unknown> }) => {
      server.inputs.push(input);
      return { _tag: "Success", value: { bot: { ...member, ...input } } };
    },
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

import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";

const member = Schema.decodeSync(BotProfile)({
  botId: "docs",
  role: "member",
  name: "Docs",
  avatar: null,
  purpose: "Keeps the guides right",
  defaultModelSelection: { instanceId: "codex", model: "gpt-small" },
  defaultProjectId: null,
  environmentId: "env-1",
  sessionThreadId: "thread-docs",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});

function setup(modelEdit: boolean) {
  server.inputs.length = 0;
  server.modelEdit = modelEdit;
}

it("sends a member's model only when the person changed it", async () => {
  setup(true);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotEditBotDialog bot={member} canSubmit onClose={onClose} />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await userEvent.click(page.getByRole("button", { name: "Use GOAT Bot's model" }));
  await expect.element(page.getByText("Same as GOAT Bot")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(server.inputs).toEqual([{ botId: "docs", defaultModelSelection: null }]);
});

it("leaves the model out of a profile edit and off a server that cannot take it", async () => {
  setup(false);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotEditBotDialog bot={member} canSubmit onClose={onClose} />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect.element(page.getByText("Model", { exact: true })).not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Docs Bot");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(server.inputs).toEqual([{ botId: "docs", name: "Docs Bot" }]);
});
