import "./goatBotScreenTestHarness";
import { act } from "react";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it } from "vite-plus/test";

import { a11y, bot, list, render, screenSession, typeInto } from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";

it("marks what the bot said since the last read, and points up to it until the person catches up", async () => {
  const reply = (id: string, createdAt: string): GoatBotRow => ({
    ...bot,
    id,
    createdAt,
    tone: "reply",
    options: [],
  });
  const opened = [
    reply("read", "2026-11-11T10:00:00Z"),
    reply("new-1", "2026-11-11T10:05:00Z"),
    reply("new-2", "2026-11-11T10:06:00Z"),
  ];
  screenSession.rows = opened;
  const snapshot = {
    key: "env:bot:1",
    readUpTo: "2026-11-11T10:01:00Z",
    newestAtOpen: "2026-11-11T10:06:00Z",
  };
  const ids = () => ((list.props?.data ?? []) as GoatBotRow[]).map((row) => row.id);
  const pill = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="2 new messages, scrolls to the first"]',
    );
  const view = await render(<GoatBotScreen visible readSnapshot={snapshot} />);
  try {
    // A reply that arrives while the person is in the chat is read as it comes.
    screenSession.rows = [...opened, reply("live", "2026-11-11T10:20:00Z")];
    await view.rerender(<GoatBotScreen visible readSnapshot={snapshot} />);
    expect(ids()).toEqual(["read", "unread-divider", "new-1", "new-2", "live"]);
    expect(pill(view.container)).toBeNull();
    const viewable = list.props?.onViewableItemsChanged as (info: {
      viewableItems: { index: number }[];
    }) => void;
    await act(async () => viewable({ viewableItems: [{ index: 3 }, { index: 4 }] }));
    expect(pill(view.container)).not.toBeNull();
    await act(async () => pill(view.container)?.click());
    expect(list.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, viewPosition: 0 }),
    );
    expect(pill(view.container)).toBeNull();
    // VoiceOver follows the jump to the "New" line once the list shows it, and only once.
    expect(a11y.focus).not.toHaveBeenCalled();
    await act(async () => viewable({ viewableItems: [{ index: 1 }, { index: 2 }] }));
    expect(a11y.focus).toHaveBeenCalledTimes(1);
    expect(a11y.focus.mock.calls[0]?.[0]?.getAttribute("aria-label")).toBe("New messages");
    await view.rerender(<GoatBotScreen visible readSnapshot={snapshot} />);
    expect(a11y.focus).toHaveBeenCalledTimes(1);
    await typeInto(view.container, "Thanks");
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(),
    );
    expect(ids()).not.toContain("unread-divider");
  } finally {
    await view.unmount();
  }

  // A task's own view keeps no read position.
  screenSession.supportsTaskThreads = true;
  const task = (await import("@goat/contracts")).ChannelTaskId.make("task-1");
  const taskView = await render(<GoatBotScreen visible taskId={task} readSnapshot={snapshot} />);
  expect(ids()).not.toContain("unread-divider");
  await taskView.unmount();
  screenSession.supportsTaskThreads = false;
  screenSession.rows = [];
});

it("keeps a card marked new when it changes again during the visit", async () => {
  const card = (updatedAt: string): GoatBotRow => ({
    kind: "task",
    id: "card",
    createdAt: "2026-11-11T09:00:00Z",
    firstInGroup: true,
    groupPosition: "single",
    card: {
      key: "task-1",
      revision: 1,
      updatedAt,
      title: "Check disks",
      statusLabel: "Running",
      tone: "active",
      sourceLabel: null,
      summary: null,
      attentionLabel: null,
      pullRequests: [],
      target: { kind: "none", label: "Unavailable" },
    },
  });
  const read = { ...bot, id: "read", createdAt: "2026-11-11T10:00:00Z", tone: "reply" as const };
  const snapshot = {
    key: "env:bot:1",
    readUpTo: "2026-11-11T10:01:00Z",
    newestAtOpen: "2026-11-11T10:05:00Z",
  };
  const ids = () => ((list.props?.data ?? []) as GoatBotRow[]).map((row) => row.id);
  screenSession.rows = [read, card("2026-11-11T10:05:00Z")];
  const view = await render(<GoatBotScreen visible readSnapshot={snapshot} />);
  try {
    expect(ids()).toEqual(["read", "unread-divider", "card"]);
    screenSession.rows = [read, card("2026-11-11T10:20:00Z")];
    await view.rerender(<GoatBotScreen visible readSnapshot={snapshot} />);
    expect(ids()).toEqual(["read", "unread-divider", "card"]);
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});
