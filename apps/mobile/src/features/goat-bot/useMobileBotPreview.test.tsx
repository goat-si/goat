import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "thread-bot" } }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ lastVisitedAt: "2026-10-12T11:00:00.000Z" }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => state.items,
}));
import { useMobileBotPreview } from "./useMobileBotPreview";

const threadId = ThreadId.make("thread-bot");
function message(
  id: string,
  type: "assistant_message" | "user_message",
  text: string,
): OrchestrationV2ProjectedTurnItem {
  const time = DateTime.makeUnsafe("2026-10-12T12:00:00Z");
  const shared = {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    messageId: MessageId.make(`m-${id}`),
    text,
  };
  const item: OrchestrationV2TurnItem =
    type === "assistant_message"
      ? { ...shared, type, streaming: false }
      : {
          ...shared,
          type,
          inputIntent: "turn_start",
          attachments: [],
          createdBy: "user",
          creationSource: "mobile",
        };
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  };
}

async function previewOf(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  state.items = [...items];
  let preview: ReturnType<typeof useMobileBotPreview> = null;
  function Probe(props: { readonly onRead: (value: typeof preview) => void }) {
    props.onRead(useMobileBotPreview());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe onRead={(value) => (preview = value)} />));
  await act(async () => root.unmount());
  return preview;
}

it("reads the roster's latest message as one plain line, without Markdown", async () => {
  expect(
    await previewOf([
      message("b1", "assistant_message", "## Status\n\n**Done.** See [PR #42](https://x.test/42)"),
    ]),
  ).toMatchObject({ text: "Status Done. See PR #42", unread: true });
  expect(
    await previewOf([message("u1", "user_message", "Run `vp test` then *ship*")]),
  ).toMatchObject({ text: "You: Run vp test then ship" });
});
