import { CommandId, EnvironmentId, MessageId, RunId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { appendPendingThreadMessages } from "./pending-thread-feed";
import { createPendingTurnAppender } from "./pending-turn-feed";
import { deriveThreadFeedPresentation } from "../../lib/threadActivity";

it("does not show a sending status for an offline or queued message", () => {
  const queued = appendPendingThreadMessages(
    [],
    [],
    [
      {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("queued"),
        commandId: CommandId.make("command"),
        text: "hello",
        attachments: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  const options = { zen: false, dispatchingMessageId: null };
  expect(createPendingTurnAppender()(queued, options)).toBe(queued);
});

it("waits while an earlier message dispatches, then holds one activity identity through acknowledgement", () => {
  const queued = appendPendingThreadMessages(
    [],
    [],
    [
      {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("queued"),
        commandId: CommandId.make("command"),
        text: "hello",
        attachments: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  const append = createPendingTurnAppender();
  expect(append(queued, { zen: false, dispatchingMessageId: MessageId.make("earlier") })).toBe(
    queued,
  );
  const sending = append(queued, { zen: false, dispatchingMessageId: MessageId.make("queued") });
  expect(sending.at(-1)).toMatchObject({
    id: "live-activity-row",
    providerStartingLabel: "Sending…",
  });
  const acknowledged = append(
    queued.map((row) => ({ ...row, acknowledged: true })),
    { zen: false, dispatchingMessageId: null },
  );
  expect(acknowledged.at(-1)).toMatchObject({
    id: "live-activity-row",
    providerStartingLabel: "Starting…",
  });
  expect(acknowledged.at(-1)?.id).toBe(sending.at(-1)?.id);
  const startedAt = "2026-01-01T00:00:00.000Z";
  const running = deriveThreadFeedPresentation(
    [],
    { runId: RunId.make("run"), status: "running", startedAt, completedAt: null },
    new Set(),
    new Set(),
    startedAt,
  );
  expect(running.find((row) => row.type === "thinking")?.id).toBe(acknowledged.at(-1)?.id);
  expect(running.find((row) => row.type === "run-fold")).toMatchObject({ workingSince: startedAt });
});
