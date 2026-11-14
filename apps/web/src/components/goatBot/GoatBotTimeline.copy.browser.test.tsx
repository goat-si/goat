import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ toasts: [] as Array<{ type?: string; title?: string }> }));
vi.mock("../ui/toast", async (original) => ({
  ...(await original<typeof import("../ui/toast")>()),
  toastManager: { add: (toast: { type?: string; title?: string }) => state.toasts.push(toast) },
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

const rows = ["First", "Second"].map((text) => ({
  kind: "bot" as const,
  id: text,
  text,
  createdAt: "2026-10-15T00:00:00Z",
  tone: "reply" as const,
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single" as const,
}));

it("shows copied only on the latest copied reply", async () => {
  state.toasts = [];
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    router: false,
  }); // No navigation links.
  using _write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const messages = screen.container.querySelectorAll("[data-follow-row]");
  const button = (index: number) =>
    messages[index]?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy"], button[aria-label="Copied"]',
    );
  const first = button(0);
  if (!first) throw new Error("missing first copy button");
  await userEvent.click(first);
  await vi.waitFor(() => expect(button(0)?.getAttribute("aria-label")).toBe("Copied"));
  expect(button(1)?.getAttribute("aria-label")).toBe("Copy");
  const second = button(1);
  if (!second) throw new Error("missing second copy button");
  await userEvent.click(second);
  await vi.waitFor(() => expect(button(1)?.getAttribute("aria-label")).toBe("Copied"));
  expect(button(0)?.getAttribute("aria-label")).toBe("Copy");
});

it("reports clipboard failure", async () => {
  state.toasts = [];
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    router: false, // No navigation links.
  });
  using _write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  using _fallback = vi.spyOn(document, "execCommand").mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: "Copy" }).first());
  await vi.waitFor(() =>
    expect(state.toasts).toEqual([expect.objectContaining({ type: "error" })]),
  );
});
