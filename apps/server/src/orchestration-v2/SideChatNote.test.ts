import { it as effectIt } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SIDE_CHAT_NOTE,
  type SideChatParentReader,
  sideChatNote,
  sideChatNoteFor,
} from "./SideChatNote.ts";
import { ProjectionStoreReadError } from "./ProjectionStore.ts";
import type { SideChatParentSnapshot } from "./SideChatParentContext.ts";

describe("sideChatNoteFor", () => {
  const parent = ThreadId.make("thread:parent");
  const parentContext = "<parent_thread>\nTitle: Nightly\n</parent_thread>";

  it("marks every side-chat prompt with the boundary followed by the parent's live state", () => {
    expect(
      sideChatNoteFor({ sideChatOf: parent }, "what was that config file?", parentContext),
    ).toBe(`${SIDE_CHAT_NOTE}\n\n${parentContext}`);
  });

  it("leaves ordinary threads alone", () => {
    expect(sideChatNoteFor({}, "continue", parentContext)).toBe("");
    expect(sideChatNoteFor({ sideChatOf: null }, "continue", parentContext)).toBe("");
  });

  it("keeps provider slash commands at the start of the prompt", () => {
    expect(sideChatNoteFor({ sideChatOf: parent }, "  /compact", parentContext)).toBe("");
  });
});

describe("sideChatNote", () => {
  const parentId = ThreadId.make("thread:parent");
  const side = { sideChatOf: parentId };
  const message = (role: "user" | "assistant", text: string) => ({
    role,
    text,
    streaming: false,
    createdAt: DateTime.makeUnsafe("2026-10-24T07:30:00.000Z"),
  });
  const parentReader = (parent: { current: SideChatParentSnapshot }) => {
    const reads: Array<ThreadId> = [];
    const reader: SideChatParentReader = {
      getThreadShell: (threadId) => Effect.sync(() => (reads.push(threadId), parent.current.shell)),
      getThreadRecords: () => Effect.sync(() => parent.current),
    };
    return { reader, reads };
  };

  effectIt.effect(
    "reads the parent again on every turn, so the side chat follows its progress",
    () =>
      Effect.gen(function* () {
        const parent: { current: SideChatParentSnapshot } = {
          current: {
            shell: {
              title: "Nightly #1111",
              status: "running",
              latestRunStopRequested: false,
              pendingRuntimeRequest: null,
              goal: { objective: "Ship nightly #1111", status: "active" },
              branch: "goat/nightly-1111",
              worktreePath: null,
              lastError: null,
            },
            messages: [message("user", "Ship #1111 to nightly")],
            plans: [],
          },
        };
        const { reader, reads } = parentReader(parent);

        const first = yield* sideChatNote(reader, side, "지금 뭐하고 있는거임");
        expect(first.startsWith(SIDE_CHAT_NOTE)).toBe(true);
        expect(first).toContain("Status: running a turn right now");
        expect(first).toContain("Goal (active): Ship nightly #1111");

        parent.current = {
          ...parent.current,
          shell: {
            ...parent.current.shell,
            status: "interrupted",
            goal: { objective: "Ship nightly #1111", status: "paused" },
          },
          messages: [...parent.current.messages, message("user", "계속")],
        };
        const second = yield* sideChatNote(reader, side, "now?");
        expect(second).toContain("Status: idle, its latest turn was interrupted by the user");
        expect(second).toContain("Goal (paused): Ship nightly #1111");
        expect(second).toContain("] 계속");
        expect(reads).toEqual([parentId, parentId]);
      }),
  );

  effectIt.effect("still sends the boundary and says so when the parent cannot be read", () =>
    Effect.gen(function* () {
      const reader: SideChatParentReader = {
        getThreadShell: (threadId) => Effect.fail(new ProjectionStoreReadError({ threadId })),
        getThreadRecords: () => Effect.die("unreachable"),
      };
      const note = yield* sideChatNote(reader, side, "status?");
      expect(note.startsWith(SIDE_CHAT_NOTE)).toBe(true);
      expect(note).toContain("could not be read");
    }),
  );

  effectIt.effect("does not read anything for ordinary threads", () =>
    Effect.gen(function* () {
      const reader: SideChatParentReader = {
        getThreadShell: () => Effect.die("ordinary threads have no parent"),
        getThreadRecords: () => Effect.die("ordinary threads have no parent"),
      };
      expect(yield* sideChatNote(reader, {}, "continue")).toBe("");
      expect(yield* sideChatNote(reader, side, "/compact")).toBe("");
    }),
  );
});
