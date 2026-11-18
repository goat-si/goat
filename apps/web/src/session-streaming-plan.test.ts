import { NodeId, PlanId, type OrchestrationV2PlanArtifact } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
} from "./session-logic";
import { makeStreamingWorkTimelineFixture, withStreamedText } from "./test-fixtures";

function streamingPlanArtifact(
  fixture: ReturnType<typeof makeStreamingWorkTimelineFixture>,
  markdown: string,
  status: "active" | "superseded",
): OrchestrationV2PlanArtifact {
  return {
    id: PlanId.make("live-plan"),
    threadId: fixture.threadId,
    runId: fixture.runId,
    nodeId: NodeId.make("live-node"),
    kind: "proposed_plan",
    markdown,
    status,
  };
}

describe("streaming plan entries", () => {
  it("keeps every other entry when streaming plan text changes", () => {
    const fixture = makeStreamingWorkTimelineFixture("proposed_plan");
    // Codex emits `plan.updated` with each delta, so the artifact array is rebuilt too.
    const plans = (markdown: string) => [streamingPlanArtifact(fixture, markdown, "active")];
    let input = {
      visibleTurnItems: withStreamedText(
        fixture.visibleTurnItems,
        fixture.streamingItemId,
        "Let",
        fixture.time(20),
      ),
      optimisticMessages: [],
      plans: plans("Let"),
    };
    let projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    for (const [step, text] of ["Let me", "Let me check the tests"].entries()) {
      input = {
        visibleTurnItems: withStreamedText(
          input.visibleTurnItems,
          fixture.streamingItemId,
          text,
          fixture.time(21 + step),
        ),
        optimisticMessages: [],
        plans: plans(text),
      };
      const previous = projection;
      projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
      expect(projection.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(input));
      for (const [index, entry] of previous.entries.entries()) {
        if (entry.id !== fixture.streamingItemId) expect(projection.entries[index]).toBe(entry);
      }
    }
  });

  it("rebuilds the plan entry when only its artifact status changes", () => {
    const fixture = makeStreamingWorkTimelineFixture("proposed_plan");
    const visibleTurnItems = withStreamedText(
      fixture.visibleTurnItems,
      fixture.streamingItemId,
      "Plan",
      fixture.time(20),
    );
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState({
      visibleTurnItems,
      optimisticMessages: [],
      plans: [streamingPlanArtifact(fixture, "Plan", "active")],
    });
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      plans: [streamingPlanArtifact(fixture, "Plan", "superseded")],
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(input));
    expect(next.entries.find((entry) => entry.kind === "proposed-plan")).toMatchObject({
      proposedPlan: { status: "superseded" },
    });
  });
});
