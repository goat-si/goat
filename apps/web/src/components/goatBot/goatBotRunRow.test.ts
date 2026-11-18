import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  OrchestrationV2TurnItemJson,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { turnItem } from "./GoatBotChatView.sync.fixtures";
import { goatBotRunReplyRow } from "./goatBotRunRow";

const threadId = ThreadId.make("bot");
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = "2026-11-14T09:00:00.000Z";

function projected(
  id: string,
  role: "user" | "assistant",
  position: number,
  channel: Record<string, unknown>,
): OrchestrationV2ProjectedTurnItem {
  const item = decodeItem({
    ...turnItem(threadId, id, role, `Text ${id}`, position),
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    channel: { conversationId: "conv", originKind: "goat", ...channel },
  });
  return { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item };
}
const reply = (id: string, inputId: string, position: number) =>
  projected(id, "assistant", position, { kind: "result", inReplyToInputId: inputId });
const botRow = (id: string): GoatBotRow => ({
  kind: "bot",
  id,
  text: `Text ${id}`,
  createdAt: at,
  tone: "result",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});

it("a run's reply row is the first shown bot row that answered its input", () => {
  const items = [reply("other", "in-0", 0), reply("first", "in-1", 1), reply("second", "in-1", 2)];
  const rows = [botRow("other"), botRow("first"), botRow("second")];
  expect(goatBotRunReplyRow(items, rows, "in-1")).toBe("first");
  // A first reply the chat folded away has no row, so the next shown one stands for the run.
  expect(goatBotRunReplyRow(items, [botRow("other"), botRow("second")], "in-1")).toBe("second");
});

it("a quiet run, a reply outside the loaded items, or a user row with the input's key give no row", () => {
  const items = [reply("other", "in-0", 0)];
  expect(goatBotRunReplyRow(items, [botRow("other")], "in-quiet")).toBeNull();
  // The reply's row is in the list, but its item is older than the loaded page.
  expect(goatBotRunReplyRow(items, [botRow("other"), botRow("old-reply")], "in-old")).toBeNull();
  const asked = projected("asked", "user", 1, { kind: "inbound", inputId: "in-2" });
  const userRow: GoatBotRow = {
    kind: "user",
    id: "asked",
    sendKey: null,
    requestKey: "in-2",
    text: "Text asked",
    createdAt: at,
    delivery: { state: "sent" },
    firstInGroup: true,
    groupPosition: "single",
    showReceipt: false,
  };
  expect(goatBotRunReplyRow([...items, asked], [botRow("other"), userRow], "in-2")).toBeNull();
});
