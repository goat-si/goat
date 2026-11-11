import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { describe, expect, it } from "vite-plus/test";

import { goatBotUnreadMark } from "./goatBotUnread";

const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
const base = { firstInGroup: true, groupPosition: "single" as const };
const bot = (id: string, minute: number): GoatBotRow => ({
  ...base,
  kind: "bot",
  id,
  text: id,
  createdAt: at(minute),
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
});
const user = (id: string, minute: number): GoatBotRow =>
  ({
    ...base,
    kind: "user",
    id,
    text: id,
    createdAt: at(minute),
    sendKey: null,
    requestKey: null,
    delivery: { state: "sent" },
    showReceipt: false,
  }) as GoatBotRow;
const card = (id: string, created: number, updated: number): GoatBotRow => ({
  ...base,
  kind: "task",
  id,
  createdAt: at(created),
  card: {
    key: id,
    revision: 2,
    updatedAt: at(updated),
    title: id,
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: id },
  },
});
const day: GoatBotRow = { kind: "day", id: "day", at: at(0) };

describe("goatBotUnreadMark", () => {
  it("marks the first bot message or kept card after the read position and counts them", () => {
    const rows = [
      day,
      bot("old", 1),
      user("mine", 5),
      bot("new-1", 6),
      card("done", 2, 7),
      bot("new-2", 8),
    ];
    expect(goatBotUnreadMark(rows, at(4), at(30))).toMatchObject({ firstId: "new-1", count: 3 });
  });

  it("reads replies newer than the chat's newest message at opening as they arrive", () => {
    const rows = [bot("waiting", 6), bot("live", 12)];
    expect(goatBotUnreadMark(rows, at(4), at(6))).toMatchObject({ firstId: "waiting", count: 1 });
    expect(goatBotUnreadMark([bot("live", 12)], at(4), at(6))).toBeNull();
    expect(goatBotUnreadMark(rows, at(4), null)).toBeNull();
  });

  it("does not count the person's own messages", () => {
    expect(goatBotUnreadMark([bot("old", 1), user("mine", 6)], at(4), at(30))).toBeNull();
  });

  it("marks nothing without a read position or when nothing is newer", () => {
    const rows = [bot("a", 1), bot("b", 2)];
    expect(goatBotUnreadMark(rows, null, at(30))).toBeNull();
    expect(goatBotUnreadMark(rows, at(3), at(30))).toBeNull();
  });
});
