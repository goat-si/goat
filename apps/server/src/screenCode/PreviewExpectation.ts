/**
 * The state a tab action's caller expects to see afterwards, and checking it on its own budget,
 * apart from the action's wait for its target and from the document settling. A check that runs
 * out is unknown, never a failed action.
 *
 * @module PreviewExpectation
 */
import type { ScreenElementRef, ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";

const DEFAULT_EXPECT_MS = 3_000;
const DEFAULT_SETTLE_MS = 5_000;
const MAX_MS = 30_000;

export interface Expectation {
  /** A wait_for condition: visible text, a URL part, or an observed element and its state. */
  readonly condition: Readonly<Record<string, unknown>>;
  readonly loadState?: "load" | "domContentLoaded";
  readonly timeoutMs: number;
  readonly settleMs: number;
}

export type CheckResult = "met" | "timeout" | "failed";

const budget = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.round(value), MAX_MS)
    : fallback;

const invalid = (nextStep: string): ScreenRunError => ({
  code: "invalid_argument",
  effectStarted: false,
  nextStep,
});

/** Reads `expect` from a tab action's argument; refs resolve now, before the action can retire them. */
export const expectationOf = (
  raw: unknown,
  resolve: (ref: ScreenElementRef) => string | undefined,
): Expectation | ScreenRunError => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return invalid("expect takes {text} | {urlIncludes} | {ref, state?}, with optional timeoutMs.");
  const value = raw as Record<string, unknown>;
  const locator =
    value.ref && typeof value.ref === "object" ? resolve(value.ref as ScreenElementRef) : undefined;
  if (value.ref !== undefined && locator === undefined)
    return {
      ...invalid("Observe again: the expected element's ref is stale."),
      code: "stale_reference",
    };
  const state = ["visible", "hidden", "detached", "attached"].includes(String(value.state))
    ? (value.state as string)
    : undefined;
  const condition = {
    ...(typeof value.text === "string" && value.text ? { text: value.text } : {}),
    ...(typeof value.urlIncludes === "string" && value.urlIncludes
      ? { urlIncludes: value.urlIncludes }
      : {}),
    ...(locator ? { locator, ...(state ? { state } : {}) } : {}),
  };
  if (Object.keys(condition).length === 0) return invalid("expect needs text, urlIncludes or ref.");
  const loadState =
    value.loadState === "load" || value.loadState === "domContentLoaded"
      ? value.loadState
      : undefined;
  return {
    condition,
    ...(loadState ? { loadState } : {}),
    timeoutMs: budget(value.timeoutMs, DEFAULT_EXPECT_MS),
    settleMs: budget(value.settleMs, DEFAULT_SETTLE_MS),
  };
};

/**
 * Waits for the document to settle when asked, then for the expected state, each on its own
 * budget, both cut to what the cell has left.
 */
export const observeExpectation = Effect.fn("PreviewExpectation.observe")(function* (
  expectation: Expectation,
  check: (
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ) => Effect.Effect<CheckResult>,
  leftMs: number,
) {
  if (expectation.loadState) {
    const settleMs = Math.max(1, Math.min(expectation.settleMs, leftMs));
    const settled = yield* check({ loadState: expectation.loadState }, settleMs);
    if (settled !== "met")
      return {
        status: settled === "timeout" ? ("unknown" as const) : ("failed" as const),
        evidence: [`observation:document not settled within ${settleMs} ms`],
      };
  }
  const timeoutMs = Math.max(1, Math.min(expectation.timeoutMs, leftMs));
  const seen = yield* check(expectation.condition, timeoutMs);
  return seen === "met"
    ? { status: "confirmed" as const, evidence: ["observation:expected state seen"] }
    : {
        status: seen === "timeout" ? ("unknown" as const) : ("failed" as const),
        evidence: [`observation:expected state not seen within ${timeoutMs} ms`],
      };
});
