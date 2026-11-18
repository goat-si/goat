import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock("~/state/channels", () => ({
  channelEnvironment: { updateBot: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("./GoatBotEditBotDialog", () => ({ useGoatBotMemberModelEditable: () => true }));
vi.mock("./goatBotMemberContext", () => ({
  useGoatBotName: () => "GOAT Bot",
  useGoatBotMainName: () => "GOAT Bot",
}));
vi.mock("./useGoatBotHome", () => ({
  useGoatBotHomeSettings: () => ({
    resolution: { state: "claimed", homeConnected: true, claim: { environmentId: "env-1" } },
  }),
}));
vi.mock("./useGoatBotModel", () => ({
  useGoatBotModel: () => ({
    activeEntry: undefined,
    selection: { instanceId: "codex", model: "gpt-main" },
    separate: true,
    entries: [],
    options: new Map(),
    allowed: true,
    save: async () => true,
  }),
}));
// The real picker needs the provider catalog. Like it, this stand-in follows `open` when given
// and keeps its own open state otherwise, and portals its popup out of the chat.
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerAriaLabel: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const [own, setOwn] = useState(false);
    const open = props.open ?? own;
    const setOpen = (next: boolean) => {
      props.onOpenChange?.(next);
      if (props.open === undefined) setOwn(next);
    };
    return (
      <>
        <button type="button" onClick={() => setOpen(!open)}>
          {props.triggerAriaLabel}
        </button>
        {open
          ? createPortal(
              <div role="dialog" aria-label="Models">
                Models
              </div>,
              document.body,
            )
          : null}
      </>
    );
  },
}));

import { GoatBotChatHidden } from "./goatBotLayout";
import { GoatBotMemberModelPicker } from "./GoatBotMemberModelPicker";
import { GoatBotModelPicker } from "./GoatBotModelPicker";

const member = Schema.decodeSync(BotProfile)({
  botId: "docs",
  role: "member",
  name: "Docs",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env-1",
  sessionThreadId: "thread-docs",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});

it.each([
  { bot: "the main bot", picker: () => <GoatBotModelPicker />, trigger: /^GOAT Bot model/ },
  {
    bot: "a member",
    picker: () => <GoatBotMemberModelPicker member={member} />,
    trigger: /^Docs model/,
  },
])(
  "$bot's model picker closes when a task replaces the chat, as unmounting did, and stays closed",
  async ({ picker, trigger }) => {
    const chat = (hidden: boolean) => (
      <GoatBotChatHidden value={hidden}>{picker()}</GoatBotChatHidden>
    );
    // The picker needs no navigation.
    await using screen = await render(chat(false), { router: false });
    await userEvent.click(screen.getByRole("button", { name: trigger }));
    const popup = page.getByRole("dialog", { name: "Models" });
    await expect.element(popup).toBeVisible();
    await screen.rerender(chat(true));
    await expect.element(popup).not.toBeInTheDocument();
    await screen.rerender(chat(false));
    expect(popup.query()).toBeNull();
  },
);
