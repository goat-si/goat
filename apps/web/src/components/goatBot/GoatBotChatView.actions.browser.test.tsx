import { EnvironmentId, ThreadId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotChatView } from "./GoatBotChatView";

it("replies, clears, sends, jumps to a source, and copies its text", async () => {
  const bot: GoatBotRow = {
    kind: "bot",
    id: "bot-1",
    text: "First line\nSecond line",
    createdAt: "2026-10-12T09:40:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  };
  const sent: GoatBotRow = {
    kind: "user",
    id: "user-1",
    sendKey: null,
    requestKey: null,
    quote: bot.text,
    reply: "answer",
    text: "answer\n\n> First line\n> Second line",
    createdAt: "2026-10-12T09:41:00Z",
    delivery: { state: "sent" },
    firstInGroup: true,
    groupPosition: "single",
    showReceipt: false,
  };
  const onSend = vi.fn();
  const view = (rows: GoatBotRow[]) => (
    <GoatBotChatView
      availability={{
        kind: "ready",
        bot: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("bot") },
      }}
      canOperate
      rows={rows}
      onSend={onSend}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
    />
  );
  await using screen = await render(view([bot]));
  using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const field = screen.getByRole("textbox", { name: "Message GOAT Bot" });
  await userEvent.type(field, "draft");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  await expect.element(field).toHaveAttribute("placeholder", "Reply…");
  expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
  await userEvent.click(screen.getByRole("button", { name: "Clear reply" }));
  await expect.element(field).not.toHaveAttribute("placeholder", "Reply…");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  await userEvent.type(field, "{Escape}");
  await expect.element(field).not.toHaveAttribute("placeholder", "Reply…");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  await userEvent.type(field, "{Enter}");
  expect(onSend).toHaveBeenCalledWith("draft\n\n> First line\n> Second line", []);
  await screen.rerender(view([bot, sent]));
  await userEvent.click(screen.getByRole("button", { name: "First line Second line" }));
  expect(document.activeElement?.getAttribute("data-bot-row")).toBe("bot-1");
  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(bot.text));
});
