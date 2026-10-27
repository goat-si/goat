import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { workRowSymbolName } from "../features/threads/thread-work-log-icons";
import { buildThreadFeed } from "./threadActivity";
import { itemIcon } from "./threadActivityIcons";

const at = DateTime.makeUnsafe("2026-10-28T00:00:00.000Z");
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
  startedAt: at,
  completedAt: at,
  updatedAt: at,
};

describe("mobile interruption presentation", () => {
  it.each(["run_interrupt_request", "run_interrupt_result"] as const)(
    "uses a stop symbol for %s",
    (type) => {
      const item: OrchestrationV2TurnItem = { ...itemBase, type, message: "Stopped by user" };
      expect(workRowSymbolName(itemIcon(item))).toBe("stop.fill");
    },
  );

  it("keeps an interrupted run neutral and stopped in the feed", () => {
    const item: OrchestrationV2TurnItem = {
      ...itemBase,
      type: "run_interrupt_result",
      message: "Stopped by user",
    };
    const activities = buildThreadFeed([
      {
        item,
        position: 0,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      },
    ]).flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []));
    expect(activities).toMatchObject([
      { icon: "stop", status: null, lifecycleStatus: "stopped", summary: "Run interrupted" },
    ]);
  });

  it("retains warning and error icons for notices and provider failures", () => {
    expect(
      itemIcon({ ...itemBase, type: "system_notice", severity: "warning", message: "Notice" }),
    ).toBe("warning");
    expect(
      itemIcon({
        ...itemBase,
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: true,
        },
      }),
    ).toBe("alert");
  });
});
