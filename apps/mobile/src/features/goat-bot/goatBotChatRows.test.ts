import { describe, expect, it } from "vite-plus/test";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";

import { goatBotChatRows } from "./goatBotChatRows";

const at = "2026-11-11T02:00:00Z";
const bot = (id: string, first: boolean, groupPosition: "single" | "first" | "middle" | "last") =>
  ({
    kind: "bot",
    id,
    text: id,
    createdAt: at,
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: first,
    groupPosition,
  }) as GoatBotRow;
const task = (id: string, first: boolean, groupPosition: "single" | "first" | "middle" | "last") =>
  ({
    kind: "task",
    id,
    createdAt: at,
    firstInGroup: first,
    groupPosition,
  }) as unknown as GoatBotRow;
const day = (id: string) => ({ kind: "day", id, at }) as GoatBotRow;
const hideTasks = (row: Exclude<GoatBotRow, { kind: "day" }>) => row.kind === "task";
const shape = (rows: GoatBotRow[]) =>
  rows.map((row) => (row.kind === "day" ? row.id : `${row.id}:${row.groupPosition}`));

describe("goatBotChatRows", () => {
  it("makes the next reply first when the hidden card opened its group", () => {
    const rows = [task("t", true, "first"), bot("a", false, "middle"), bot("b", false, "last")];
    expect(shape(goatBotChatRows(rows, hideTasks))).toEqual(["a:first", "b:last"]);
  });

  it("makes the previous reply last when the hidden card closed its group", () => {
    const rows = [bot("a", true, "first"), task("t", false, "last")];
    expect(shape(goatBotChatRows(rows, hideTasks))).toEqual(["a:single"]);
  });

  it("keeps group boundaries the full timeline drew", () => {
    const rows = [bot("a", true, "single"), task("t", true, "first"), bot("b", false, "last")];
    expect(shape(goatBotChatRows(rows, hideTasks))).toEqual(["a:single", "b:single"]);
  });

  it("drops a day stamp that headed only hidden rows", () => {
    const rows = [day("d1"), bot("a", true, "single"), day("d2"), task("t", true, "single")];
    expect(shape(goatBotChatRows(rows, hideTasks))).toEqual(["d1", "a:single"]);
  });

  it("leaves the timeline as it was when nothing is hidden", () => {
    const rows = [day("d1"), bot("a", true, "first"), bot("b", false, "last")];
    expect(goatBotChatRows(rows, () => false)).toEqual(rows);
  });
});
