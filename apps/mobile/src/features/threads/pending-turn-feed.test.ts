import { expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { appendPendingThreadMessages } from "./pending-thread-feed";
import { createPendingTurnAppender } from "./pending-turn-feed";

it("holds stable turn rows while a sent message waits for its run", () => {
  const sent = appendPendingThreadMessages(
    [],
    [],
    [
      {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("sent"),
        commandId: CommandId.make("command"),
        text: "hello",
        attachments: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  const append = createPendingTurnAppender();
  const held = append(sent, { zen: false, dispatchingMessageId: MessageId.make("sent") });
  expect(held.map((row) => row.id)).toEqual(["sent", "pending-fold:sent", "live-activity-row"]);
  expect(append(sent, { zen: false, dispatchingMessageId: MessageId.make("sent") })[1]).toBe(
    held[1],
  );
  expect(
    append(sent, { zen: true, dispatchingMessageId: MessageId.make("sent") }).map((row) => row.id),
  ).toEqual(["sent", "live-activity-row"]);
});
