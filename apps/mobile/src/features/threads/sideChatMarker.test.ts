import { describe, expect, it } from "vite-plus/test";
import { sideChatMarker } from "./sideChatMarker";

const sideChat = { environmentId: "env-a", sideChatOf: "parent" };
const parent = {
  environmentId: "env-a",
  id: "parent",
  title: "Fix the login flow",
  archivedAt: null,
  deletedAt: null,
};

describe("sideChatMarker", () => {
  it("marks nothing on a thread that is not a side chat", () => {
    expect(sideChatMarker({ environmentId: "env-a", sideChatOf: null }, parent)).toBeNull();
    expect(sideChatMarker({ environmentId: "env-a" }, parent)).toBeNull();
  });

  it("links a live parent by its title and reference", () => {
    expect(sideChatMarker(sideChat, parent)).toEqual({
      parent: { environmentId: "env-a", threadId: "parent", title: "Fix the login flow" },
    });
  });

  // Archived and deleted shells leave the device's index; these guard a stale shell.
  it("does not link an archived parent", () => {
    expect(sideChatMarker(sideChat, { ...parent, archivedAt: "2026-11-11T00:00:00.000Z" })).toEqual(
      { parent: null },
    );
  });

  it("does not link a deleted parent", () => {
    expect(sideChatMarker(sideChat, { ...parent, deletedAt: "2026-11-11T00:00:00.000Z" })).toEqual({
      parent: null,
    });
  });

  it("does not link a parent that is unknown or not loaded yet", () => {
    expect(sideChatMarker(sideChat, null)).toEqual({ parent: null });
  });

  it("does not link a thread with the parent's id in another environment", () => {
    expect(sideChatMarker(sideChat, { ...parent, environmentId: "env-b" })).toEqual({
      parent: null,
    });
  });
});
