import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { ChannelTaskChip, type OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { MobileTaskChips } from "./mobileBotTaskStatus";
import { useMobileTaskChips } from "./useMobileTaskChips";

const at = "2026-11-15T02:00:00.000Z";
const decodeChip = Schema.decodeUnknownSync(ChannelTaskChip);
const chip = (taskVersion: number, openQuestionCount: number) =>
  decodeChip({
    taskId: "task",
    conversationId: "conversation",
    taskVersion,
    title: "Task",
    status: "running",
    originKind: "goat",
    requesterLabel: "You",
    createdAt: at,
    updatedAt: at,
    openQuestionCount,
  });
// Only the fields the chips read; the rest of a projected item does not matter here.
const items = (ledgerTask: ChannelTaskChip, reply: string) =>
  [
    { sourceItemId: "card", item: { type: "notification", ledgerTask } },
    { sourceItemId: "reply", item: { type: "assistant_message", text: reply, streaming: true } },
  ] as unknown as ReadonlyArray<OrchestrationV2ProjectedTurnItem>;

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const seen: MobileTaskChips[] = [];
  function Probe(props: {
    items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    revision: string | null;
  }) {
    seen.push(useMobileTaskChips(props.items, props.revision));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const show = (next: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, revision: string) =>
    act(async () => root.render(<Probe items={next} revision={revision} />));
  return { seen, show, unmount: () => act(async () => root.unmount()) };
}

it("hands Home the same chips while a reply streams, and new ones when a task record moves", async () => {
  const { seen, show, unmount } = setup();
  await show(items(chip(1, 0), "On"), "task:1");
  const first = seen.at(-1);
  // Streamed tokens give new items with the same work revision.
  await show(items(chip(1, 0), "On it"), "task:1");
  await show(items(chip(1, 0), "On it."), "task:1");
  expect(seen.at(-1)).toBe(first);
  // A newer task record changes the revision, so the chips are read again.
  await show(items(chip(2, 1), "On it."), "task:2");
  expect(seen.at(-1)).not.toBe(first);
  expect(seen.at(-1)?.get(chip(2, 1).taskId)?.openQuestionCount).toBe(1);
  await unmount();
});
