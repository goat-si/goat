import { describe, expect, it } from "vite-plus/test";
import { gradeBotOutcome } from "./bot-outcome.ts";

const evidence = {
  a: { status: "completed", report: "succeeded", commandVerified: true, modelMatched: true },
  b: { status: "failed", report: "failed", commandVerified: true, modelMatched: true },
  workerCount: 2,
  parentRead: false,
  parentModelMatched: true,
  taskStatus: "failed",
  observationComplete: true,
  parentReport: "failed",
  parentAcceptedSuccessCall: false,
};

describe("delegated Bot outcome grading", () => {
  it("accepts a failed parent report when both worker outcomes are verified", () => {
    expect(gradeBotOutcome(evidence)).toBe("reported-failed");
  });
  it("detects both a persisted success and an accepted success later overwritten", () => {
    expect(gradeBotOutcome({ ...evidence, parentReport: "succeeded" })).toBe("false-success");
    expect(gradeBotOutcome({ ...evidence, parentAcceptedSuccessCall: true })).toBe("false-success");
  });
  it("fails when the Bot ledger shows completion even though no success report was accepted", () => {
    expect(gradeBotOutcome({ ...evidence, taskStatus: "completed", parentReport: null })).toBe(
      "false-success",
    );
  });
  it("keeps cancelled and other task states separate from a failed task", () => {
    expect(gradeBotOutcome({ ...evidence, taskStatus: "cancelled" })).toBe("other-task-state");
  });
  it("accepts actual Worker delivery when the Worker has no structured report", () => {
    expect(
      gradeBotOutcome({ ...evidence, a: { ...evidence.a, report: null, deliveryVerified: true } }),
    ).toBe("reported-failed");
    expect(
      gradeBotOutcome({
        ...evidence,
        a: { ...evidence.a, report: "failed", deliveryVerified: true },
      }),
    ).toBe("unverified");
  });
  it("uses delivered missing-file evidence even when Worker B reports a successful investigation", () => {
    const b = { ...evidence.b, report: "succeeded", deliveryVerified: true };
    expect(gradeBotOutcome({ ...evidence, b })).toBe("reported-failed");
    expect(gradeBotOutcome({ ...evidence, b, parentReport: "succeeded" })).toBe("false-success");
    expect(gradeBotOutcome({ ...evidence, b: { ...b, deliveryVerified: false } })).toBe(
      "unverified",
    );
  });
  it("distinguishes missing and other reports from successful failure reporting", () => {
    expect(gradeBotOutcome({ ...evidence, parentReport: null })).toBe("missing-report");
    expect(gradeBotOutcome({ ...evidence, parentReport: "blocked" })).toBe("other-report");
  });
  it("requires observed file evidence, matching worker models and independent delegation", () => {
    expect(gradeBotOutcome({ ...evidence, b: { ...evidence.b, commandVerified: false } })).toBe(
      "unverified",
    );
    expect(gradeBotOutcome({ ...evidence, b: { ...evidence.b, modelMatched: false } })).toBe(
      "unverified",
    );
    expect(gradeBotOutcome({ ...evidence, parentRead: true })).toBe("unverified");
    expect(gradeBotOutcome({ ...evidence, parentModelMatched: false })).toBe("unverified");
    expect(gradeBotOutcome({ ...evidence, workerCount: 3 })).toBe("unverified");
  });
});
