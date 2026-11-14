import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

vi.mock("./useGoatBotFace", async (original) => ({
  ...(await original<typeof import("./useGoatBotFace")>()),
  useGoatBotReading: (since: string | null) => since !== null,
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotActivityContext } from "./GoatBotTimeline";

const env = EnvironmentId.make("reply-regions");
const ref = { environmentId: env, threadId: ThreadId.make("bot") };
const baseline = new Set(["old"]);
const reply = (id: string): Extract<GoatBotRow, { kind: "bot" }> => ({
  kind: "bot",
  id,
  text: id,
  createdAt: "2026-10-12T09:40:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
const old = reply("old");
const view = (rows: ReadonlyArray<GoatBotRow>, work: boolean, reading = false) => (
  <GoatBotActivityContext value={work ? { state: "working", text: "Tool step" } : null}>
    <GoatBotChatView
      projectionRef={ref}
      environmentId={env}
      availability={{ kind: "ready", bot: ref }}
      canOperate
      rows={rows}
      source={{
        identity: "main:reply-regions:bot",
        baselineIds: baseline,
        sourceIds: new Set(rows.map((row) => TurnItemId.make(row.id))),
        committedSends: new Map(),
      }}
      replyingSince={reading ? "now" : null}
      onSend={() => true}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
    />
  </GoatBotActivityContext>
);

it("keeps reply announcements independent of activity and of the reading signal, and alternates replies", async () => {
  await using screen = await render(view([old], true));
  const replyStatus = screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]");
  expect(replyStatus).not.toBeNull();
  if (!replyStatus) throw new Error("missing reply status");
  expect(replyStatus.textContent).toBe("");
  const activity = screen.container.querySelector<HTMLElement>(
    '[role="status"][aria-atomic="true"]:not([aria-label])',
  );
  if (!activity) throw new Error("missing activity status");
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => changes.push(...batch));
  observer.observe(replyStatus, { subtree: true, childList: true, characterData: true });
  try {
    const first = reply("first");
    await screen.rerender(view([old, first], true));
    expect(replyStatus.textContent).toBe("GOAT Bot replied.");
    expect(activity.textContent).toBe("GOAT Bot is working");
    expect(changes).toHaveLength(1);
    await screen.rerender(view([old, first], false));
    expect(activity.textContent).toBe("GOAT Bot is done");
    expect(replyStatus.textContent).toBe("GOAT Bot replied.");
    expect(changes).toHaveLength(1);
    const second = reply("second");
    await screen.rerender(view([old, first, second], false));
    expect(replyStatus.textContent).toBe("New reply from GOAT Bot.");
    expect(changes).toHaveLength(2);
    await screen.rerender(view([old, first, second], false, true));
    // A read the server reports, for a message this chat did not send, changes nothing here.
    expect(replyStatus.textContent).toBe("New reply from GOAT Bot.");
    expect(changes).toHaveLength(2);
    expect(activity.textContent).toBe("Reading your message");
  } finally {
    observer.disconnect();
  }
});

it("does not mutate the reply text when the bot finishes working", async () => {
  await using screen = await render(view([old], true));
  const first = reply("first");
  await screen.rerender(view([old, first], true));
  const status =
    screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]") ??
    screen.container.querySelector<HTMLElement>('[role="status"][aria-atomic="true"]');
  if (!status) throw new Error("missing status");
  expect(status.textContent).toContain("GOAT Bot replied.");
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => changes.push(...batch));
  observer.observe(status, { subtree: true, childList: true, characterData: true });
  try {
    await screen.rerender(view([old, first], false));
    expect(changes).toHaveLength(0);
  } finally {
    observer.disconnect();
  }
});

it("clears the reply as soon as the composer accepts a send", async () => {
  await using screen = await render(view([old], true));
  const first = reply("first");
  await screen.rerender(view([old, first], true));
  const status =
    screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]") ??
    screen.container.querySelector<HTMLElement>('[role="status"][aria-atomic="true"]');
  if (!status) throw new Error("missing status");
  expect(status.textContent).toContain("GOAT Bot replied.");
  await userEvent.fill(screen.getByRole("textbox", { name: "Message GOAT Bot" }), "Next message");
  await userEvent.keyboard("{Enter}");
  expect(status.textContent).not.toContain("GOAT Bot replied.");
});

it("keeps a reply that arrives after a send when that send's reading signal comes late", async () => {
  await using screen = await render(view([old], true));
  const status = screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]");
  if (!status) throw new Error("missing reply status");
  await userEvent.fill(screen.getByRole("textbox", { name: "Message GOAT Bot" }), "Next message");
  await userEvent.keyboard("{Enter}");
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => changes.push(...batch));
  observer.observe(status, { subtree: true, childList: true, characterData: true });
  try {
    const update = reply("update");
    await screen.rerender(view([old, update], true));
    expect(status.textContent).toBe("GOAT Bot replied.");
    // The server's read of that send arrives only now.
    await screen.rerender(view([old, update], true, true));
    expect(status.textContent).toBe("GOAT Bot replied.");
    expect(changes).toHaveLength(1);
  } finally {
    observer.disconnect();
  }
});

it("writes a reply that arrives in the same update as a reading signal", async () => {
  await using screen = await render(view([old], true));
  const status = screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]");
  if (!status) throw new Error("missing reply status");
  await screen.rerender(view([old, reply("first")], true, true));
  expect(status.textContent).toBe("GOAT Bot replied.");
});
