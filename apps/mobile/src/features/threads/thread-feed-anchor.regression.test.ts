import { expect, it } from "vite-plus/test";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";

it("keeps a short thread anchored to its first message when a follow-up is sent", () => {
  expect(
    resolveThreadFeedSubmissionAnchor({
      currentAnchorMessageId: "first",
      submittedMessageId: "follow-up",
      hasStartedTurn: true,
      hasUserMessage: true,
      queuedMessageCount: 0,
      deliveryDeferred: false,
    }),
  ).toBe("first");
});
