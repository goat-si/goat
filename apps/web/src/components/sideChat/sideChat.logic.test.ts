import { ThreadId, type OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  canOpenSideChat,
  findSideChatThread,
  parseSideChatCommand,
  sideChatRows,
} from "./sideChat.logic";

describe("parseSideChatCommand", () => {
  it("reads the question after /side", () => {
    expect(parseSideChatCommand("/side what does this test cover?")).toEqual({
      prompt: "what does this test cover?",
    });
    expect(parseSideChatCommand("  /SIDE\nfirst line\nsecond line ")).toEqual({
      prompt: "first line\nsecond line",
    });
  });

  it("opens an empty side chat for a bare /side", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
  });

  it("ignores other commands and prose that mentions /side", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("please /side this")).toBeNull();
  });
});

describe("findSideChatThread", () => {
  const parentId = ThreadId.make("parent");
  const parent = makeThreadFixture({ id: parentId });
  const parentRef = scopeThreadRef(parent.environmentId, parentId);
  const side = (id: string, createdAt: string, extra: object = {}) => ({
    ...makeThreadFixture({ id: ThreadId.make(id) }),
    sideChatOf: parentId,
    createdAt,
    ...extra,
  });

  it("picks the newest live side chat of the parent", () => {
    const older = side("older", "2026-10-13T01:00:00.000Z");
    const newer = side("newer", "2026-10-13T02:00:00.000Z");
    const deleted = side("deleted", "2026-10-13T03:00:00.000Z", {
      deletedAt: "2026-10-13T03:05:00.000Z",
    });
    expect(findSideChatThread([parent, older, newer, deleted], parentRef)?.id).toBe("newer");
  });

  it("finds nothing for a thread without a side chat", () => {
    const other = { ...side("other", "2026-10-13T01:00:00.000Z"), sideChatOf: ThreadId.make("x") };
    expect(findSideChatThread([parent, other], parentRef)).toBeNull();
  });

  it("does not offer a side chat inside a side chat", () => {
    expect(canOpenSideChat(parent)).toBe(true);
    expect(canOpenSideChat(side("nested", "2026-10-13T01:00:00.000Z"))).toBe(false);
    expect(canOpenSideChat(null)).toBe(false);
  });
});

describe("sideChatRows", () => {
  const base = {
    position: 0,
    sourceThreadId: ThreadId.make("side"),
  };
  // Only the fields sideChatRows reads; the rest of a turn item is irrelevant here.
  const projected = (
    visibility: OrchestrationV2ProjectedTurnItem["visibility"],
    item: { readonly type: string; readonly id: string; readonly [field: string]: unknown },
  ) =>
    ({
      ...base,
      visibility,
      sourceItemId: item.id,
      item,
    }) as unknown as OrchestrationV2ProjectedTurnItem;

  it("shows only the side chat's own exchange, not the inherited parent history", () => {
    const rows = sideChatRows([
      projected("inherited", { type: "user_message", id: "parent-q", text: "build it" }),
      projected("inherited", {
        type: "assistant_message",
        id: "parent-a",
        text: "done",
        streaming: false,
      }),
      projected("local", { type: "user_message", id: "q", text: "which file?" }),
      projected("local", { type: "reasoning", id: "r", text: "thinking", streaming: false }),
      projected("local", { type: "assistant_message", id: "a", text: "", streaming: true }),
    ]);
    expect(rows).toEqual([
      { kind: "user", id: "q", text: "which file?" },
      { kind: "assistant", id: "a", text: "", streaming: true },
    ]);
  });
});
