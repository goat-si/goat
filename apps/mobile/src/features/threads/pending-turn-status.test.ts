import { expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { appendPendingThreadMessages } from "./pending-thread-feed";
import { createPendingTurnAppender } from "./pending-turn-feed";

it("shows sending then starting in the actual thinking row label", () => {
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
  expect(append(sent, { zen: false }).at(-1)).toMatchObject({
    type: "thinking",
    providerStartingLabel: "Sending…",
  });
  expect(
    append(
      sent.map((row) => ({ ...row, acknowledged: true })),
      { zen: false },
    ).at(-1),
  ).toMatchObject({ type: "thinking", providerStartingLabel: "Starting…" });
});
