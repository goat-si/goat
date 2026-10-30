import {
  PreviewAutomationEvaluateInput,
  PreviewAutomationLogsInput,
  type ScreenRunError,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isLogsInput = Schema.is(PreviewAutomationLogsInput);

export const readTabLogs = Effect.fn("PreviewTargetHost.logs")(function* (
  arg: Record<string, unknown>,
  invoke: (input: unknown) => Effect.Effect<unknown, ScreenRunError>,
) {
  const input = arg.since === undefined ? {} : { since: arg.since };
  if (!isLogsInput(input))
    return yield* Effect.fail({
      code: "invalid_argument" as const,
      effectStarted: false,
      nextStep: "Provide an ISO 8601 date-time for since.",
    });
  const value = yield* invoke(input);
  return { value, category: "confirmed" as const, evidence: ["Browser logs read"] };
});

const isEvaluation = Schema.is(PreviewAutomationEvaluateInput);
export const evaluateTab = Effect.fn("PreviewTargetHost.evaluate")(function* (
  arg: Record<string, unknown>,
  invoke: (input: unknown) => Effect.Effect<unknown, ScreenRunError>,
) {
  const input = { expression: arg.expression };
  if (!isEvaluation(input))
    return yield* Effect.fail({
      code: "invalid_argument" as const,
      effectStarted: false,
      nextStep: "Provide a nonempty, bounded expression.",
    });
  const value = yield* invoke(input);
  return {
    value: value ?? null,
    category: "unverifiable" as const,
    evidence: ["Evaluation completed"],
  };
});
