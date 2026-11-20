import { expect, it } from "vite-plus/test";
import { hasCompactableConversation } from "./ChatView.logic";

it("enables compaction when the user message is on an older page", () => {
  expect(
    hasCompactableConversation({
      visibleTurnItems: [],
      hasMoreHistory: true,
      latestUserMessageAt: "2026-10-26T08:00:00.000Z",
    }),
  ).toBe(true);
  expect(
    hasCompactableConversation({
      visibleTurnItems: [],
      hasMoreHistory: true,
      latestUserMessageAt: null,
    }),
  ).toBe(false);
});
