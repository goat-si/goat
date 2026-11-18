import { MessageId, NodeId, RunId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  selectHandoffImageResources,
  selectMessageImageResources,
  createMessageAttachmentPreviewProjector,
} from "./session-logic";

describe("image asset requests", () => {
  const image = {
    type: "image" as const,
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 42,
  };
  const message = {
    id: MessageId.make("image-message"),
    role: "user" as const,
    text: "Inspect these images",
    runId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    streaming: false,
    attachments: [image],
  };

  it("requests the whole row's gallery and crops without signing local preview IDs", () => {
    const attachments = Object.freeze([
      image,
      { ...image, id: "second" },
      { ...image, id: "crop", name: "preview-annotation-1.png" },
      { ...image, id: "local", previewUrl: "blob:local" },
      { ...image, id: "inline", previewUrl: "data:image/png;base64,AA==" },
      { ...image, id: "provided", previewUrl: "https://preview.test/image" },
      { ...image, type: "file" as const, id: "file", mimeType: "application/pdf" },
      { ...image, type: "future", id: "unknown" },
      image,
    ]);

    expect(selectMessageImageResources(attachments)).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "second" },
      { _tag: "attachment", attachmentId: "crop" },
      { _tag: "attachment", attachmentId: "provided" },
    ]);
  });

  it("requests offscreen handoffs without signing the rest of the loaded history", () => {
    const history = {
      ...message,
      id: MessageId.make("history"),
      attachments: [{ ...image, id: "history-image" }],
    };
    const offscreen = {
      ...message,
      id: MessageId.make("offscreen"),
      attachments: [image, { ...image, id: "crop", name: "preview-annotation-1.png" }],
    };
    const empty = {
      ...message,
      id: MessageId.make("empty"),
      attachments: [{ ...image, id: "empty" }],
    };
    const assistant = {
      ...message,
      id: MessageId.make("assistant"),
      role: "assistant" as const,
      attachments: [{ ...image, id: "assistant-image" }],
    };
    expect(
      selectHandoffImageResources([history, message, offscreen, empty, assistant], {
        [message.id]: ["blob:message"],
        [offscreen.id]: ["blob:offscreen", "blob:crop"],
        [empty.id]: [],
        [assistant.id]: ["blob:unused"],
      }),
    ).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "crop" },
    ]);
  });

  it("hands signed URLs to a mounted row only after the local preview is released", () => {
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const row = createMessageAttachmentPreviewProjector();
    const pending = handoff(
      server(message, () => undefined),
      () => "blob:pending",
    );
    expect(selectMessageImageResources(pending.attachments)).toEqual([]);
    expect(selectHandoffImageResources([message], { [message.id]: ["blob:pending"] })).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);

    const ready = server(message, () => "https://server.test/image");
    expect(selectMessageImageResources(handoff(ready, () => "blob:pending").attachments)).toEqual(
      [],
    );
    const released = server(message, () => undefined);
    expect(selectMessageImageResources(released.attachments)).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);
    const displayed = row(released, () => "https://server.test/image");
    expect(displayed).toEqual(ready);
    expect(pending.attachments?.[0]).toMatchObject({ previewUrl: "blob:pending" });
    expect(row(released, () => "https://server.test/renewed").attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/renewed",
    });
    expect(displayed.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(row(released, () => undefined)).toBe(message);
  });
});

it("renders automatic completion as a work entry instead of a user bubble", () => {
  const now = DateTime.makeUnsafe("2026-09-09T00:00:00Z");
  const item = {
    id: TurnItemId.make("wake-item"),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("wake-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "notification" as const,
    source: { kind: "delegated_task" as const, taskIds: [NodeId.make("task-1")] },
    outcome: "unknown" as const,
    summary: "Delegated task finished",
  };
  const row = {
    item,
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  };
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    optimisticMessages: [],
    visibleTurnItems: [row],
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "work",
    entry: { label: "Delegated task finished", tone: "info", projectedItem: row },
  });
  expect(
    deriveTimelineEntriesFromVisibleTurnItems({
      optimisticMessages: [],
      visibleTurnItems: [
        {
          ...row,
          item: {
            ...item,
            type: "user_message",
            messageId: MessageId.make("wake-message"),
            createdBy: "agent" as const,
            creationSource: "server" as const,
            inputIntent: "turn_start" as const,
            attachments: [],
            text: "Delegated task node:task-1 reached a terminal state. Use task_status with taskId node:task-1 to read the result.",
          },
        },
      ],
    })[0]?.kind,
  ).toBe("message");
});
