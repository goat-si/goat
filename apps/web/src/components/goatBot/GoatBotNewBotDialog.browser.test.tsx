import { BotProfile, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

const server = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  failFirst: true,
}));
const created = vi.hoisted(() => ({ bot: null as unknown }));

vi.mock("~/state/channels", () => ({ channelEnvironment: { createBot: {} } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: Record<string, unknown> }) => {
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
it("creates a bot with its model and keeps one request id when a save is retried", async () => {
  created.bot = decodeProfile({
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
  await expect.element(page.getByText("Same as GOAT Bot")).toBeVisible();
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Research");
  await userEvent.fill(page.getByRole("textbox", { name: "Avatar" }), "🔎");
  await userEvent.fill(page.getByRole("textbox", { name: "Purpose" }), "Find sources");
  await userEvent.click(page.getByRole("button", { name: "New bot model: gpt-main" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection lost");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created.bot));
  expect(server.inputs).toHaveLength(2);
  expect(server.inputs[0]).toMatchObject({
    name: "Research",
    avatar: "🔎",
    purpose: "Find sources",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-small" },
  });
  expect(server.inputs[1]?.clientRequestId).toBe(server.inputs[0]?.clientRequestId);
});
