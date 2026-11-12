import { describe, expect, it } from "vite-plus/test";
import type { GoatBotRow } from "./rows.ts";
import { goatBotUnreadIds } from "./unread.ts";

const bot = (id: string, createdAt: string): GoatBotRow => ({
  kind: "bot",
  id,
  createdAt,
  text: id,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
const task: GoatBotRow = {
  kind: "task",
  id: "task",
  createdAt: "2026-01-01T00:00:00Z",
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 2,
    updatedAt: "2026-01-03T00:00:00Z",
    title: "Task",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "None" },
  },
};
const visit = "2026-01-02T00:00:00Z";
describe("goatBotUnreadIds", () => {
  it("is empty when nothing is unread", () => {
    expect([...goatBotUnreadIds([bot("old", visit)], visit)]).toEqual([]);
  });
  it("finds unread bot rows in order", () => {
    expect([
      ...goatBotUnreadIds(
        [
          bot("old", visit),
          bot("new", "2026-01-03T00:00:00Z"),
          bot("next", "2026-01-04T00:00:00Z"),
        ],
        visit,
      ),
    ]).toEqual(["new", "next"]);
  });
  it("uses the task revision time", () => {
    expect([...goatBotUnreadIds([task], visit)]).toEqual(["task"]);
  });
  it("treats a missing visit as unread", () => {
    expect([...goatBotUnreadIds([task, bot("new", visit)], null)]).toEqual(["task", "new"]);
  });
});
