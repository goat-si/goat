import {
  PreviewAutomationEvaluateInput,
  PreviewAutomationFillSecretInput,
  PreviewAutomationLogsInput,
  PreviewAutomationUploadInput,
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

export const answerDialog = Effect.fn("PreviewTargetHost.dialog")(function* (
  arg: Record<string, unknown>,
  invoke: (input: unknown) => Effect.Effect<unknown, ScreenRunError>,
) {
  if (
    (arg.action !== "accept" && arg.action !== "dismiss") ||
    (arg.promptText !== undefined && typeof arg.promptText !== "string")
  )
    return yield* Effect.fail({
      code: "invalid_argument" as const,
      effectStarted: false,
      nextStep: "Use accept or dismiss and optional prompt text.",
    });
  const input = {
    accept: arg.action === "accept",
    ...(arg.promptText === undefined ? {} : { promptText: arg.promptText }),
  };
  const value = yield* invoke(input);
  return { value, category: "unverifiable" as const, evidence: ["Dialog answered"] };
});

const isUpload = Schema.is(PreviewAutomationUploadInput);
export const uploadTab = Effect.fn("PreviewTargetHost.upload")(function* (
  arg: Record<string, unknown>,
  locator: string | undefined,
  invoke: (input: unknown) => Effect.Effect<unknown, ScreenRunError>,
) {
  const input = { locator, paths: arg.files };
  if (!locator || !isUpload(input))
    return yield* Effect.fail({
      code: "invalid_argument" as const,
      effectStarted: false,
      nextStep: "Provide a file input and up to 20 file paths.",
    });
  const value = yield* invoke(input);
  return { value: value ?? {}, category: "unverifiable" as const, evidence: ["Upload dispatched"] };
});

const isSecret = Schema.is(PreviewAutomationFillSecretInput);
export const fillTabSecret = Effect.fn("PreviewTargetHost.fillSecret")(function* (
  arg: Record<string, unknown>,
  invoke: (input: unknown) => Effect.Effect<unknown, ScreenRunError>,
) {
  const input = {
    secretRef: arg.secretRef,
    ...(arg.selector === undefined ? {} : { selector: arg.selector }),
  };
  if (!isSecret(input))
    return yield* Effect.fail({
      code: "invalid_argument" as const,
      effectStarted: false,
      nextStep: "Provide a secret reference and optional CSS selector.",
    });
  const value = yield* invoke(input);
  return { value, category: "unverifiable" as const, evidence: ["Secret fill completed"] };
});
