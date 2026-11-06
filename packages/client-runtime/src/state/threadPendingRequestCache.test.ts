import { describe, expect, it } from "@effect/vitest";
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
});
