import { EnvironmentId, ThreadId, type BotProfile } from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

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

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotMainProfileContext } from "./goatBotMemberContext";

const example = "Review the latest changes";

function setup(canOperate: boolean) {
  const onSend = vi.fn<(text: string) => void>();
  const view = (
    <GoatBotChatView
      availability={{
        kind: "ready",
        bot: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("bot") },
      }}
      canOperate={canOperate}
      rows={[]}
      onSend={onSend}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
    />
  );
  return { view, onSend };
}

it("seeds the composer without sending and refills it when the same example is picked again", async () => {
  const { view, onSend } = setup(true);
  await using screen = await render(view);
  const { container } = screen;
  expect(container.querySelector("h1")?.textContent).toContain("GOAT Bot");
  expect(container.querySelector("header p")).toBeNull();
  const exampleButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === example,
  );
  expect(exampleButton).toBeDefined();
  await act(() => exampleButton!.click());
  let textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe(example);
  expect(onSend).not.toHaveBeenCalled();

  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(textarea.value).toBe("");
  await act(() => exampleButton!.click());
  textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe(example);
  expect(onSend).not.toHaveBeenCalled();
});

it("does not offer example buttons without send permission", async () => {
  const { view } = setup(false);
  await using screen = await render(view);
  const { container } = screen;
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === example),
  ).toBe(false);
});

it("names the main chat and its message box for the renamed main bot", async () => {
  const { view } = setup(true);
  const main = { botId: "main", role: "main", name: "Goaty" } as BotProfile;
  await using screen = await render(
    <GoatBotMainProfileContext value={main}>{view}</GoatBotMainProfileContext>,
  );
  expect(screen.container.querySelector("h1")?.textContent).toContain("Goaty");
  await expect.element(screen.getByRole("textbox", { name: "Message Goaty" })).toBeVisible();
});

it("centers the example buttons under the title", async () => {
  const { view } = setup(true);
  await using screen = await render(view);
  const { container } = screen;
  const title = container.querySelector("[data-slot='empty-title']")!;
  const center = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.left + box.width / 2;
  };
  const examples = [...container.querySelectorAll("button")].filter((button) =>
    ["Fix the flaky test in my project", example, "How is the work going?"].includes(
      button.textContent ?? "",
    ),
  );
  expect(examples).toHaveLength(3);
  for (const button of examples)
    expect(Math.abs(center(button) - center(title))).toBeLessThanOrEqual(1);
});

it("has its status region before the first message, so the first reading is heard", async () => {
  const now = "2026-10-15T00:00:00.000Z";
  vi.setSystemTime(Date.parse(now));
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
  const bot = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("bot") };
  const view = (
    rows: Parameters<typeof GoatBotChatView>[0]["rows"],
    replyingSince: string | null,
  ) => (
    <GoatBotChatView
      availability={{ kind: "ready", bot }}
      canOperate
      rows={rows}
      replyingSince={replyingSince}
      onSend={() => {}}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
    />
  );
  await using screen = await render(view([], null));
  const region = screen.container.querySelector('[role="status"][aria-live="polite"]');
  expect(region?.textContent).toBe("");
  const first = {
    kind: "bot" as const,
    id: "b1",
    text: "Hello",
    createdAt: "2026-10-15T00:00:00.000Z",
    tone: "reply" as const,
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single" as const,
  };
  await screen.rerender(view([first], now));
  await expect.poll(() => region?.textContent).toBe("Reading your message");
  expect(screen.container.querySelector('[role="status"][aria-live="polite"]')).toBe(region);
});
