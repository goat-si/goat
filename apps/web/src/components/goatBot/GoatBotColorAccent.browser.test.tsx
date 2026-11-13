import { goatBotAccent, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import "~/index.css";

const state = vi.hoisted(() => ({
  colorCapability: true,
  updates: [] as Array<Record<string, unknown>>,
}));

// A member's color reaches a server that advertises the capability; this stands in for one.
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: "offline" },
    serverConfig: {
      environment: {
        capabilities: { goatBotProfileColor: state.colorCapability },
      },
    },
  }),
}));
vi.mock("~/state/channels", () => ({ channelEnvironment: { updateBot: {}, createBot: {} } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: Record<string, unknown> }) => {
      state.updates.push(input);
      return {
        _tag: "Success",
        value: { bot: member(typeof input.color === "string" ? input.color : undefined) },
      };
    },
}));
vi.mock("./useGoatBotModel", () => ({
  useGoatBotModel: () => ({
    selection: { instanceId: "codex", model: "gpt-main" },
    entries: [],
    options: new Map(),
  }),
}));
// The real picker needs the provider catalog; these stand-ins hold a fixed model.
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotMemberModelPicker", () => ({ GoatBotMemberModelPicker: () => null }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
// The name chip draws the real member avatar, so its picture is what a person sees.
vi.mock("./GoatBotAvatar", async (original) => ({
  ...(await original<typeof import("./GoatBotAvatar")>()),
  GoatBotMainAvatar: () => null,
}));
// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";
import { GoatBotMemberContext } from "./goatBotMemberContext";

const decodeProfile = Schema.decodeSync(BotProfile);
const member = (color: string | undefined) =>
  decodeProfile({
    botId: "docs",
    role: "member",
    name: "Docs",
    avatar: null,
    purpose: "Keeps the guides right",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env-1",
    sessionThreadId: "thread-docs",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...(color === undefined ? {} : { color }),
  });

function setup(colorCapability: boolean) {
  state.colorCapability = colorCapability;
  state.updates.length = 0;
}

it("hides the swatches on a server that cannot store a color, and sends none", async () => {
  setup(false);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotEditBotDialog bot={member(undefined)} canSubmit onClose={onClose} />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  expect(page.getByRole("radiogroup", { name: "Bot color" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(state.updates).toEqual([]);
});

it("moves the swatch choice with the arrow keys and saves that color", async () => {
  setup(true);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotEditBotDialog bot={member(undefined)} canSubmit onClose={onClose} />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const group = page.getByRole("radiogroup", { name: "Bot color" });
  await expect.element(group).toBeVisible();
  const neutral = page.getByRole("radio", { name: "Neutral" });
  await expect.element(neutral).toBeChecked();
  await userEvent.click(neutral);
  await userEvent.keyboard("{ArrowRight}");
  const blue = page.getByRole("radio", { name: "Blue" });
  await expect.element(blue).toBeChecked();
  await expect.element(blue).toHaveFocus();
  await expect.element(neutral).not.toBeChecked();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(state.updates).toEqual([{ botId: "docs", color: "#2563EB" }]);
});

const personRow: GoatBotRow = {
  kind: "user",
  sendKey: null,
  requestKey: null,
  id: "hello",
  text: "Morning",
  createdAt: "2026-11-07T10:00:00.000Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "read", readAt: "2026-11-07T10:00:01.000Z" },
  showReceipt: false,
};

function chat(bot: BotProfile) {
  return (
    <GoatBotMemberContext value={bot}>
      <GoatBotChatView
        availability={{
          kind: "ready",
          bot: {
            environmentId: EnvironmentId.make("env-1"),
            threadId: ThreadId.make("thread-docs"),
          },
        }}
        canOperate
        rows={[personRow]}
        onSend={() => {}}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
    </GoatBotMemberContext>
  );
}

it("puts a colored member's accent on its chat, and nowhere for a member without one", async () => {
  setup(true);
  await using colored = await render(chat(member("#2F6FED")));
  const root = colored.container.querySelector<HTMLElement>('[style*="--goat-bot-accent"]');
  expect(root).not.toBeNull();
  expect(root!.style.getPropertyValue("--goat-bot-accent")).toBe("#2F6FED");
  const accent = goatBotAccent({ role: "member", color: "#2F6FED" })!;
  expect(root!.style.getPropertyValue("--goat-bot-accent-foreground")).toBe(accent.foreground);
  const pill = colored.container.querySelector(".goat-person-pill");
  expect(pill).not.toBeNull();
  expect(getComputedStyle(pill!).backgroundColor).toBe("rgb(47, 111, 237)");
  expect(getComputedStyle(pill!).color).toBe(
    accent.foreground === "#000000" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
  );

  await using neutral = await render(chat(member(undefined)));
  expect(neutral.container.querySelector('[style*="--goat-bot-accent"]')).toBeNull();
  expect(
    getComputedStyle(neutral.container.querySelector(".goat-person-pill")!).backgroundColor,
  ).not.toBe("rgb(47, 111, 237)");
});

it("shows a member's own initial in the name chip, not the main bot's face", async () => {
  setup(true);
  await using screen = await render(chat(member("#2F6FED")));
  const chip = screen.getByRole("button", { name: "Docs home" });
  await expect.element(chip).toBeVisible();
  await expect.element(chip.getByText("D", { exact: true })).toBeVisible();
});

it("accented Send appears only once the box has something to send", async () => {
  setup(true);
  await using screen = await render(chat(member("#2F6FED")));
  const send = screen.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
  expect(send).not.toBeNull();
  expect(getComputedStyle(send!).backgroundColor).not.toBe("rgb(47, 111, 237)");
  await userEvent.type(screen.getByRole("textbox", { name: "Message Docs" }), "Any news?");
  await vi.waitFor(() => expect(getComputedStyle(send!).backgroundColor).toBe("rgb(47, 111, 237)"));
});
