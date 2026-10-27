import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import { CircleAlertIcon, SquareIcon } from "~/components/solar";

import { subagentResumedSince } from "./V2LifecycleRow.logic";
import { v2EventPresentation } from "./TimelineV2EventRow.logic";

const failedAt = "2026-10-09T12:21:00.000Z";
const beforeFailure = DateTime.makeUnsafe("2026-10-09T12:05:00.000Z");
const afterFailure = DateTime.makeUnsafe("2026-10-09T12:48:00.000Z");

const itemBase = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "interrupted" as const,
  title: null,
  startedAt: beforeFailure,
  completedAt: afterFailure,
  updatedAt: afterFailure,
};

describe("run interruption presentation", () => {
  it.each(["run_interrupt_request", "run_interrupt_result"] as const)(
    "shows %s as a neutral stop while retaining its message",
    (type) => {
      const item: OrchestrationV2TurnItem = { ...itemBase, type, message: "Stopped by user" };
      expect(v2EventPresentation(item)).toMatchObject({
        tone: "muted",
        icon: SquareIcon,
        detail: "Stopped by user",
      });
    },
  );

  it("still shows an actual provider failure as an error", () => {
    const item: OrchestrationV2TurnItem = {
      ...itemBase,
      type: "error",
      status: "failed",
      failure: { class: "provider_error", message: "Provider failed", code: null, retryable: true },
    };
    expect(v2EventPresentation(item)).toMatchObject({ tone: "danger", icon: CircleAlertIcon });
  });
});

describe("subagentResumedSince", () => {
  it("is true while it runs even when the notification was delivered after the resume", () => {
    expect(
      subagentResumedSince(
        { status: "running", startedAt: afterFailure },
        "2026-10-09T12:50:00.000Z",
      ),
    ).toBe(true);
  });

  // regression: #18099 a resumed subagent's old failure notification row showed failed instead of resumed
  it("is true once a run started after the notification has settled", () => {
    expect(subagentResumedSince({ status: "completed", startedAt: afterFailure }, failedAt)).toBe(
      true,
    );
  });

  it("is false for the run the notification reported on", () => {
    expect(subagentResumedSince({ status: "failed", startedAt: beforeFailure }, failedAt)).toBe(
      false,
    );
  });
});
