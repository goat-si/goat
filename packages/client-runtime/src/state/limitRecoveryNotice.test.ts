import { describe, expect, it } from "vite-plus/test";
import { NodeId, ProviderTurnId, RunId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveUsageLimitNoticeRows,
  limitRecoveryOwnsSnooze,
  limitRecoveryHoldsSnooze,
  withoutUsageLimitNoticeRows,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

describe("usage-limit recovery presentation", () => {
  it("hides only the current run's duplicate limit row", () => {
    const runId = RunId.make("limited");
    const root = NodeId.make("root");
    const turnId = ProviderTurnId.make("turn");
    const run = {
      id: runId,
      threadId: v2Projection.thread.id,
      ordinal: 1,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: null,
      rootNodeId: root,
      activeAttemptId: null,
      status: "failed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const failure = {
      id: TurnItemId.make("current"),
      threadId: v2Projection.thread.id,
      runId,
      nodeId: root,
      providerThreadId: null,
      providerTurnId: turnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: { class: "usage_limit" as const, message: "limit", code: null, retryable: null },
    };
    const previous = { ...failure, id: TurnItemId.make("previous"), runId: RunId.make("older") };
    const notice = deriveUsageLimitNoticeRows({
      ...v2Projection,
      runs: [run],
      turnItems: [previous, failure],
    } as never);
    const rows = [{ item: previous }, { item: failure }] as never;
    expect(withoutUsageLimitNoticeRows(rows, notice).map(({ item }) => item.id)).toEqual([
      previous.id,
    ]);
    expect(
      deriveUsageLimitNoticeRows({
        ...v2Projection,
        runs: [{ ...run, status: "running" }],
        turnItems: [previous, failure],
      } as never),
    ).toBeNull();
  });
  it("only claims a snooze owned by the same recovery run and reset", () => {
    const runId = RunId.make("run");
    const resetAt = "2026-08-01T12:00:00Z";
    const recovery = { runId, resetAt, snooze: true, autoResume: false };
    expect(
      limitRecoveryOwnsSnooze({
        runId,
        resetAt,
        recovery,
        snoozedUntil: "2026-08-01T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil: "2026-08-01T13:00:00Z" }),
    ).toBe(false);
    expect(
      limitRecoveryOwnsSnooze({
        runId: RunId.make("other"),
        resetAt,
        recovery,
        snoozedUntil: resetAt,
      }),
    ).toBe(false);
  });
  it("keeps ordinary snooze controls available while a request is pending", () => {
    const runId = RunId.make("run");
    const resetAt = "2026-08-01T12:00:00Z";
    const thread = {
      latestRun: { runId, completedAt: "2026-07-30T12:00:00Z" },
      updatedAt: "2026-07-30T12:00:00Z",
      settledOverride: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      snoozedUntil: resetAt,
      limitRecovery: { runId, resetAt, snooze: true, autoResume: false },
    } as unknown as Parameters<typeof limitRecoveryHoldsSnooze>[0] & {};
    const runtime = {
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: resetAt,
    } as never;
    expect(limitRecoveryHoldsSnooze(thread, runtime)).toBe(true);
    expect(limitRecoveryHoldsSnooze({ ...thread, hasPendingUserInput: true }, runtime)).toBe(false);
    expect(
      limitRecoveryHoldsSnooze({ ...thread, snoozedUntil: "2026-08-02T12:00:00Z" }, runtime),
    ).toBe(false);
  });
});
