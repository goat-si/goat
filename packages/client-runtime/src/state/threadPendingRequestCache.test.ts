import { describe, expect, it } from "@effect/vitest";
import { RuntimeRequestId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { PENDING_QUESTION, questionProjection } from "./threadsSyncFixtures.ts";
import { hasMissingPendingRequestCard } from "./threadPendingRequestCache.ts";

describe("cached pending questions", () => {
  it("detects a missing pending question card without rejecting complete or resolved state", () => {
    const complete = questionProjection(v2Projection);
    expect(hasMissingPendingRequestCard(complete)).toBe(false);
    expect(hasMissingPendingRequestCard({ ...complete, turnItems: [] })).toBe(true);
    expect(
      hasMissingPendingRequestCard({
        ...complete,
        turnItems: [],
        runtimeRequests: [{ ...PENDING_QUESTION, status: "resolved" }],
      }),
    ).toBe(false);
  });
  it.each(["command", "file-read", "file-change", "mcp-elicitation", "permission"] as const)(
    "requires the card for a pending %s approval",
    (kind) => {
      const id = RuntimeRequestId.make(`approval-${kind}`);
      const approval = { ...PENDING_QUESTION, id, kind };
      const card = {
        ...questionProjection(v2Projection).turnItems[0],
        id: TurnItemId.make(`card-${kind}`),
        type: "approval_request",
        requestId: id,
        requestKind: kind,
        prompt: "Allow?",
        options: [],
      } as OrchestrationV2TurnItem;
      const projection = { ...v2Projection, runtimeRequests: [approval], turnItems: [] };
      expect(hasMissingPendingRequestCard(projection)).toBe(true);
      expect(hasMissingPendingRequestCard({ ...projection, turnItems: [card] })).toBe(false);
      const wrongCard = {
        ...questionProjection(v2Projection).turnItems[0],
        requestId: id,
      } as OrchestrationV2TurnItem;
      expect(hasMissingPendingRequestCard({ ...projection, turnItems: [wrongCard] })).toBe(true);
      expect(
        hasMissingPendingRequestCard({
          ...projection,
          runtimeRequests: [{ ...approval, status: "resolved" }],
        }),
      ).toBe(false);
    },
  );

  it.each(["auth_refresh", "dynamic_tool_call"] as const)(
    "does not require an approval card for %s",
    (kind) => {
      expect(
        hasMissingPendingRequestCard({
          ...v2Projection,
          runtimeRequests: [{ ...PENDING_QUESTION, kind }],
          turnItems: [],
        }),
      ).toBe(false);
    },
  );
});
