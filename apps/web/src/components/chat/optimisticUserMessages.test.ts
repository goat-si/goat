import { MessageId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import {
  applyOptimisticUserMessagesAction,
  createOptimisticBlobPreviews,
  dropOptimisticHandoff,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
} from "./optimisticUserMessages";

const threadA = "environment-a:thread-a";
const threadB = "environment-a:thread-b";

function message(id: string, previewUrl?: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: id,
    runId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    streaming: false,
    ...(previewUrl
      ? {
          attachments: [
            {
              type: "image",
              id: `${id}-image`,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
              previewUrl,
            },
          ],
        }
      : {}),
  };
}

const ids = (...values: string[]) => new Set(values.map((value) => MessageId.make(value)));

describe("optimistic user messages", () => {
  it("an acknowledged message stays gone after the server drops its row", () => {
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      message("m1"),
      message("m2", "blob:two"),
    ]);
    state = reconcileOptimisticUserMessages(state, threadA, ids("m1", "m2"));
    expect(state.messages).toEqual([]);
    expect(state.handoff).toEqual({ m2: ["blob:two"] });

    // A cancelled queued run or a rewind removes the server's copy again.
    state = reconcileOptimisticUserMessages(state, threadA, ids());
    expect(state.messages).toEqual([]);

    state = dropOptimisticHandoff(state, threadA, MessageId.make("m2"));
    expect(state.handoff).toEqual({});
  });

  it("releases the previous thread's messages when the thread changes", () => {
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      message("a1"),
    ]);
    state = reconcileOptimisticUserMessages(state, threadB, ids());
    state = reconcileOptimisticUserMessages(state, threadA, ids());
    expect(state).toEqual(emptyOptimisticUserMessages(threadA));
  });

  it("drops a late update for a thread the view has left", () => {
    const state = reconcileOptimisticUserMessages(
      applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
        message("a1"),
      ]),
      threadB,
      ids(),
    );
    expect(applyOptimisticUserMessagesAction(state, threadA, [message("a2")])).toBe(state);
  });

  it("revokes a thread's blob previews once, when their use ends or the thread is left", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    previews.track(threadA, message("a1", "blob:a1"));
    previews.track(threadA, message("a2", "blob:a2"));
    previews.track(threadB, message("b1", "blob:b1"));

    previews.revoke(threadA, ["blob:a1"]);
    previews.revokeThread(threadA);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:a1", "blob:a2"]);
  });

  it("a send that fails after the server acknowledged it leaves the handed-off previews shown", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    const sent = message("m1", "blob:m1");
    previews.track(threadA, sent);
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      sent,
    ]);
    state = reconcileOptimisticUserMessages(state, threadA, ids("m1"));
    previews.handOff(state);

    previews.release(threadA, sent);
    expect(revoke).not.toHaveBeenCalled();

    previews.revokeThread(threadA);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:m1"]);
  });

  it("a send that fails before acknowledgement revokes its previews", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    const sent = message("m1", "blob:m1");
    previews.track(threadA, sent);
    const state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      sent,
    ]);
    previews.handOff(reconcileOptimisticUserMessages(state, threadA, ids()));

    previews.release(threadA, sent);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:m1"]);
  });

  it("rejects late appends, removals and handoff completions across environments", () => {
    const otherEnvironment = "environment-b:thread-a";
    const sent = message("same-id", "blob:other");
    let state = applyOptimisticUserMessagesAction(
      emptyOptimisticUserMessages(otherEnvironment),
      otherEnvironment,
      [sent],
    );
    const lateRemoval = vi.fn(() => []);
    expect(applyOptimisticUserMessagesAction(state, threadA, [message("late")])).toBe(state);
    expect(applyOptimisticUserMessagesAction(state, threadA, lateRemoval)).toBe(state);
    expect(lateRemoval).not.toHaveBeenCalled();
    state = reconcileOptimisticUserMessages(state, otherEnvironment, ids("same-id"));
    expect(dropOptimisticHandoff(state, threadA, sent.id)).toBe(state);
    expect(state.handoff).toEqual({ "same-id": ["blob:other"] });
  });

  it("keeps another environment's previews alive when leaving a thread", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    const otherEnvironment = "environment-b:thread-a";
    const sent = message("m1", "blob:other");
    previews.track(otherEnvironment, sent);
    previews.revokeThread(threadA);
    expect(revoke).not.toHaveBeenCalled();
    previews.revokeThread(otherEnvironment);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:other"]);
  });
});
