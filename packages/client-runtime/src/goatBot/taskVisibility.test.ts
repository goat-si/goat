import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { BotThreadRow } from "@goat/contracts";
import { botRowRetiresAt, botThreadKey, selectBotChildren } from "./taskVisibility.ts";

const decodeRow = Schema.decodeSync(BotThreadRow);
const now = Date.parse("2026-11-04T12:00:00.000Z");
const row = (
  id: string,
  hours: number,
  options: { done?: boolean; messages?: number; pinned?: boolean; terminal?: boolean } = {},
) => {
  const at = DateTime.formatIso(DateTime.makeUnsafe(now - hours * 3_600_000));
  return decodeRow({
    kind: "task",
    task: {
      taskId: id,
      title: id,
      status: options.done || options.terminal ? "completed" : "waiting_input",
      updatedAt: at,
    },
    view: {
      taskId: id,
      pinnedAt: options.pinned ? at : null,
      doneAt: options.done ? at : null,
      readThrough: null,
    },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: options.messages ?? 0,
  });
};
const select = (
  rows: ReturnType<typeof row>[],
  selectedKey: string | null = null,
  showMore = false,
) => selectBotChildren({ rows, now, showMore, selectedKey });

describe("bot task visibility", () => {
  it("hides quiet completed tasks at two hours and ten messages", () => {
    const before = row("before", 1.999, { done: true, messages: 10 });
    const at = row("at", 2, { done: true, messages: 10 });
    const nine = row("nine", 2, { done: true, messages: 9 });
    expect(select([before, at, nine]).rows).toEqual([before, nine]);
  });
  it("hides terminal tasks without a done flag at two hours and ten messages", () => {
    const before = row("before", 1.999, { terminal: true, messages: 10 });
    const at = row("at", 2, { terminal: true, messages: 10 });
    const nine = row("nine", 2, { terminal: true, messages: 9 });
    const old = row("old", 73, { terminal: true, messages: 9 });
    expect(select([before, at, nine, old]).rows).toEqual([before, nine, old]);
  });
  it("keeps selected and pinned tasks after three days", () => {
    const before = row("before", 71.999, { done: true });
    const old = row("old", 72, { done: true });
    const pinned = row("pinned", 73, { done: true, pinned: true });
    expect(select([before, old, pinned]).rows).toEqual([pinned, before]);
    expect(select([old, pinned], botThreadKey(old)).rows).toEqual([old, pinned]);
  });
  it("shows five recent ordinary rows until expanded", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(String(i), i, { done: true }));
    expect(select(rows)).toEqual({ rows: rows.slice(0, 5), hasMore: true });
    expect(select(rows, null, true)).toEqual({ rows, hasMore: false });
  });
});

describe("a history row's capped main-message count", () => {
  it("retires a row exactly when the exact count would", () => {
    for (const terminal of [false, true])
      for (const done of [false, true])
        for (let exact = 0; exact <= 30; exact++)
          expect(
            botRowRetiresAt(row("t", 1, { terminal, done, messages: Math.min(exact, 10) })),
          ).toBe(botRowRetiresAt(row("t", 1, { terminal, done, messages: exact })));
  });
});
