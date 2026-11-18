import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  ChannelInputId,
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { turnItem } from "./GoatBotChatView.sync.fixtures";

import "~/index.css";

// Whether the window is narrow, and whether each Show run press found a row to show.
const state = vi.hoisted(() => ({ narrow: false, offered: [] as boolean[] }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("./GoatBotFileViewer", () => ({ GoatBotFileViewer: () => <p>Open file</p> }));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
// Home stands in as the run popover's Show in chat, read from the chat's context, and a Library
// file row.
vi.mock("./GoatBotWorkPanel", async () => {
  const { useContext } = await import("react");
  const { GoatBotRunInChat } = await import("./goatBotRunRow");
  function GoatBotWorkPanel(props: {
    onOpenFile: (file: { relativePath: string; size: number; modifiedAt: string }) => void;
  }) {
    const showRunInChat = useContext(GoatBotRunInChat);
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            const show = showRunInChat?.("in-1");
            state.offered.push(show !== undefined);
            show?.();
          }}
        >
          Show run
        </button>
        <button
          type="button"
          onClick={() =>
            props.onOpenFile({
              relativePath: "notes.md",
              size: 1,
              modifiedAt: "2026-11-14T09:00:00Z",
            })
          }
        >
          Open notes
        </button>
      </div>
    );
  }
  return { GoatBotWorkPanel };
});

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChatHidden } from "./goatBotLayout";

function setup(narrow: boolean) {
  state.narrow = narrow;
  state.offered = [];
}

const threadId = ThreadId.make("bot");
const at = "2026-11-14T09:00:00.000Z";
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const replyItem = decodeItem({
  ...turnItem(threadId, "reply-1", "assistant", "Morning digest: all green.", 0),
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  channel: {
    conversationId: "conv",
    originKind: "goat",
    kind: "result",
    inReplyToInputId: ChannelInputId.make("in-1"),
  },
});
const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = [
  {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: replyItem.id,
    item: replyItem,
  },
];
const replyRow: GoatBotRow = {
  kind: "bot",
  id: "reply-1",
  text: "Morning digest: all green.",
  createdAt: at,
  tone: "result",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const earlier: GoatBotRow = { ...replyRow, id: "earlier", text: "Earlier message" };

function view(hidden = false) {
  return (
    // Home docks only in a chat view of 752px or more; the 980px window gate is faked above.
    <div style={{ width: 1200, height: 700, display: "flex" }}>
      <GoatBotChatHidden value={hidden}>
        <GoatBotChatView
          availability={{
            kind: "ready",
            bot: { environmentId: EnvironmentId.make("local"), threadId },
          }}
          canOperate
          rows={[earlier, replyRow]}
          visibleTurnItems={visibleTurnItems}
          onSend={() => {}}
          onRetryInput={() => {}}
          legacyAgentRoute={null}
        />
      </GoatBotChatHidden>
    </div>
  );
}
const focusedRow = () => document.activeElement?.getAttribute("data-bot-row");

it("Show in chat focuses the run's reply beside the chat at once, and is not offered while a file or a task covers the chat", async () => {
  setup(false);
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(screen.getByRole("button", { name: "Show run" }));
  expect(state.offered).toEqual([true]);
  expect(focusedRow()).toBe("reply-1");
  // Home stays open beside the chat.
  await expect.element(screen.getByRole("button", { name: "Show run" })).toBeVisible();
  await screen.rerender(view(true));
  await userEvent.click(screen.getByRole("button", { name: "Show run" }));
  await screen.rerender(view());
  await userEvent.click(screen.getByRole("button", { name: "Open notes" }));
  await expect.element(screen.getByText("Open file")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show run" }));
  expect(state.offered).toEqual([true, false, false]);
});

it("Show in chat from the sheet closes it and lands on the reply instead of the Home chip", async () => {
  setup(true);
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(page.getByRole("button", { name: "Show run" }));
  expect(state.offered).toEqual([true]);
  await expect.element(page.getByRole("button", { name: "Show run" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedRow()).toBe("reply-1"));
});
