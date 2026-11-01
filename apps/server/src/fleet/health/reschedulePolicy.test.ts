import { describe, expect, it } from "@effect/vitest";
import type { HostCondition, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import {
  attemptOfBranch,
  backoffDelayMs,
  BACKOFF_MAX_MS,
  nextAttemptBranch,
  nextHealingStep,
} from "./reschedulePolicy.ts";
import {
  classifyThread,
  type ThreadHealth,
  type ThreadStatusSnapshot,
} from "./threadHealthModel.ts";

const runId = "run:1" as RunId;
const quiet = { repeated: false, fallbackExhausted: false, hostDraining: false };
const failed = (
  failureClass: Extract<ThreadHealth, { _tag: "failed" }>["failureClass"],
): ThreadHealth => ({
  _tag: "failed",
  failureClass,
  runId,
});

describe("reschedule decision table", () => {
  it.each<[string, ThreadHealth, Partial<typeof quiet>, string]>([
    [
      "a stall is interrupted and steered first",
      { _tag: "stalled", idleMs: 1 },
      {},
      "interrupt_and_steer",
    ],
    [
      "a repeated stall is rescheduled",
      { _tag: "stalled", idleMs: 1 },
      { repeated: true },
      "reschedule:stalled",
    ],
    [
      "a lost host reschedules at once",
      { _tag: "host_lost", since: "" },
      {},
      "reschedule:host_unreachable",
    ],
    ["a usage limit goes to the fallback chain", failed("usage_limit"), {}, "fallback"],
    ["a transport error goes to the fallback chain", failed("transport_error"), {}, "fallback"],
    [
      "an exhausted chain reschedules",
      failed("provider_error"),
      { fallbackExhausted: true },
      "reschedule:failed",
    ],
    ["a permission error blocks the goal", failed("permission_error"), {}, "blocked"],
    ["a validation error blocks the goal", failed("validation_error"), {}, "blocked"],
    ["an unknown failure reschedules", failed("unknown"), {}, "reschedule:failed"],
    [
      "drain moves an idle attempt",
      { _tag: "healthy", idle: true },
      { hostDraining: true },
      "reschedule:drain",
    ],
    [
      "drain lets a running turn finish",
      { _tag: "healthy", idle: false },
      { hostDraining: true },
      "none",
    ],
    [
      "a waiting attempt is never a stall, even on a draining host",
      { _tag: "waiting" },
      { hostDraining: true },
      "none",
    ],
    ["unknown health takes no action", { _tag: "unknown" }, {}, "none"],
  ])("%s", (_name, health, context, expected) => {
    const step = nextHealingStep(health, { ...quiet, ...context });
    expect(step._tag === "reschedule" ? "reschedule:" + step.reason : step._tag).toBe(expected);
  });

  it("backs off with full jitter under a growing, capped ceiling", () => {
    expect(backoffDelayMs(0, 0)).toBe(0);
    expect(backoffDelayMs(0, 0.999)).toBeLessThan(30_000);
    expect(backoffDelayMs(3, 0.999)).toBeGreaterThan(3.9 * 60_000);
    expect(backoffDelayMs(3, 0.999)).toBeLessThan(4 * 60_000);
    expect(backoffDelayMs(20, 0.999)).toBeLessThan(BACKOFF_MAX_MS);
  });

  it("gives every attempt its own branch without stacking suffixes", () => {
    expect(attemptOfBranch("feat/x")).toBe(1);
    expect(nextAttemptBranch("feat/x")).toBe("feat/x-a2");
    expect(nextAttemptBranch("feat/x-a2")).toBe("feat/x-a3");
    expect(nextAttemptBranch("goal-s0-a1")).toBe("goal-s0-a2");
  });
});

describe("thread health", () => {
  const now = Date.parse("2026-10-20T01:00:00.000Z");
  const ago = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000));
  const status = (overrides: Partial<ThreadStatusSnapshot>): ThreadStatusSnapshot => ({
    phase: "running",
    run: { runId },
    pendingRequest: null,
    queuedRunId: null,
    lastActivityAt: ago(1),
    ...overrides,
  });
  const classify = (
    snapshot: ThreadStatusSnapshot | null,
    hostConditions: ReadonlyArray<HostCondition> = [],
  ) => classifyThread({ status: snapshot, hostConditions, now })._tag;

  it("calls a running thread stalled only after twenty quiet minutes", () => {
    expect(classify(status({ lastActivityAt: ago(19) }))).toBe("healthy");
    expect(classify(status({ lastActivityAt: ago(21) }))).toBe("stalled");
  });

  it("treats a pending question or a queued run as waiting, however old", () => {
    expect(
      classify(status({ phase: "waiting_input", lastActivityAt: ago(600), pendingRequest: {} })),
    ).toBe("waiting");
    expect(classify(status({ queuedRunId: "run:2" as RunId, lastActivityAt: ago(600) }))).toBe(
      "waiting",
    );
  });

  it("reports a failure with its class, and unknown for a host that predates the field", () => {
    expect(
      classifyThread({
        status: status({ phase: "failed", lastErrorClass: "transport_error" }),
        hostConditions: [],
        now,
      }),
    ).toEqual(failed("transport_error"));
    expect(
      classifyThread({ status: status({ phase: "failed" }), hostConditions: [], now }),
    ).toEqual(failed("unknown"));
  });

  it("is host_lost on a Lost host and unknown while the host is only unreachable", () => {
    const lost: HostCondition = { type: "Lost", since: ago(1), message: "" };
    expect(classify(null, [lost])).toBe("host_lost");
    expect(classify(null, [{ type: "Unreachable", since: ago(2), message: "" }])).toBe("unknown");
  });
});
