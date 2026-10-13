import { ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SIDE_CHAT_NOTE, sideChatNoteFor } from "./SideChatNote.ts";

describe("sideChatNoteFor", () => {
  const parent = ThreadId.make("thread:parent");

  it("marks every side-chat prompt with the side-chat boundary", () => {
    expect(sideChatNoteFor({ sideChatOf: parent }, "what was that config file?")).toBe(
      SIDE_CHAT_NOTE,
    );
  });

  it("leaves ordinary threads alone", () => {
    expect(sideChatNoteFor({}, "continue")).toBe("");
    expect(sideChatNoteFor({ sideChatOf: null }, "continue")).toBe("");
  });

  it("keeps provider slash commands at the start of the prompt", () => {
    expect(sideChatNoteFor({ sideChatOf: parent }, "  /compact")).toBe("");
  });
});
