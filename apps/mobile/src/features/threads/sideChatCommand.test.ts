import { describe, expect, it } from "vite-plus/test";
import { parseSideChatCommand, findSideChat } from "./sideChatCommand";

describe("mobile side chat commands", () => {
  it("recognizes both aliases only at the start of a whole message", () => {
    expect(parseSideChatCommand(" /SIDE  why? ")).toEqual({ prompt: "why?" });
    expect(parseSideChatCommand("/btw\nhello")).toEqual({ prompt: "hello" });
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("ask /side why")).toBeNull();
  });
  it("chooses the newest live side chat only in the parent environment", () => {
    const candidates = [
      {
        id: "a",
        environmentId: "one",
        sideChatOf: "parent",
        archivedAt: null,
        deletedAt: null,
        createdAt: "2026-01-01",
      },
      {
        id: "b",
        environmentId: "other",
        sideChatOf: "parent",
        archivedAt: null,
        deletedAt: null,
        createdAt: "2026-01-03",
      },
      {
        id: "c",
        environmentId: "one",
        sideChatOf: "parent",
        archivedAt: null,
        deletedAt: null,
        createdAt: "2026-01-02",
      },
      {
        id: "d",
        environmentId: "one",
        sideChatOf: "parent",
        archivedAt: "yes",
        deletedAt: null,
        createdAt: "2026-01-04",
      },
    ];
    expect(findSideChat(candidates, "one", "parent")?.id).toBe("c");
  });
});
