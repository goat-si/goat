import { describe, expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const selection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("codex"),
  model: "alias",
  options: [
    { id: "effort", value: "high" },
    { id: "flag", value: false },
  ],
});
const summary = M.GenerateMemorySummaryInput.make({
  cwd: "scratch",
  sourceThread: { environmentId: M.EnvironmentId.make("env"), threadId: M.ThreadId.make("thread") },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic", completed: true }],
  modelSelection: selection,
});
const result = { text: "Synthetic result", assertionKind: "inference" as const, evidence: [] };

import { withMemoryExecution, type MemorySelectedRunner } from "./memoryGenerationRunner.ts";
import { buildMemorySummaryPrompt } from "./memoryGenerationPrompts.ts";
import { outputDecodeOptions } from "./textGenerationOperations.ts";
describe("memory generation runner", () => {
  it.effect("binds requested instance environment and effective selection before returning", () =>
    Effect.gen(function* () {
      const selected: MemorySelectedRunner = (request) =>
        Schema.decodeUnknownEffect(request.outputSchema)({ summary: result }).pipe(
          Effect.map((result) => ({ result, effectiveModel: "resolved-model" })),
          Effect.mapError(
            (cause) =>
              new M.TextGenerationError({
                operation: request.operation,
                detail: "Fixture decode failed.",
                cause,
              }),
          ),
        );
      const runner = withMemoryExecution(
        { providerInstanceId: selection.instanceId, environmentId: M.EnvironmentId.make("owner") },
        M.ProviderDriverKind.make("codex"),
        selected,
      );
      const output = yield* runner({
        operation: "generateMemorySummary",
        cwd: summary.cwd,
        modelSelection: selection,
        ...(yield* buildMemorySummaryPrompt(summary)),
      });
      expect(output.execution).toEqual({
        requestedModelSelection: selection,
        effectiveProvider: "codex",
        effectiveModel: "resolved-model",
        providerInstanceId: "codex",
        environmentId: "owner",
      });
    }),
  );
  it.effect("missing identity and mismatched instance never invoke provider", () =>
    Effect.gen(function* () {
      let calls = 0;
      const selected: MemorySelectedRunner = (request) => {
        calls++;
        return Effect.fail(
          new M.TextGenerationError({
            operation: request.operation,
            detail: "Unexpected provider invocation.",
          }),
        );
      };
      const request = {
        operation: "generateMemorySummary" as const,
        cwd: summary.cwd,
        modelSelection: selection,
        ...(yield* buildMemorySummaryPrompt(summary)),
      };
      for (const context of [
        undefined,
        { providerInstanceId: selection.instanceId },
        {
          providerInstanceId: M.ProviderInstanceId.make("foreign"),
          environmentId: M.EnvironmentId.make("owner"),
        },
      ]) {
        expect(
          (yield* Effect.exit(
            withMemoryExecution(context, M.ProviderDriverKind.make("codex"), selected)(request),
          ))._tag,
        ).toBe("Failure");
      }
      expect(calls).toBe(0);
    }),
  );
  it.effect("rejects forged execution fields inside model JSON", () =>
    Effect.gen(function* () {
      const selected: MemorySelectedRunner = (request) =>
        // Providers decode raw memory output with outputDecodeOptions; this fixture does the same.
        Schema.decodeUnknownEffect(request.outputSchema)(
          { ...result, execution: { environmentId: "forged" } },
          outputDecodeOptions(request.operation),
        ).pipe(
          Effect.map((result) => ({ result, effectiveModel: "effective" })),
          Effect.mapError(
            (cause) =>
              new M.TextGenerationError({
                operation: request.operation,
                detail: "Fixture decode failed.",
                cause,
              }),
          ),
        );
      const request = {
        operation: "generateMemorySummary" as const,
        cwd: summary.cwd,
        modelSelection: selection,
        ...(yield* buildMemorySummaryPrompt(summary)),
      };
      expect(
        (yield* Effect.exit(
          withMemoryExecution(
            {
              providerInstanceId: selection.instanceId,
              environmentId: M.EnvironmentId.make("owner"),
            },
            M.ProviderDriverKind.make("codex"),
            selected,
          )(request),
        ))._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("refuses attachments and investigation before spawn", () =>
    Effect.gen(function* () {
      let calls = 0;
      const selected: MemorySelectedRunner = (request) => {
        calls++;
        return Effect.fail(
          new M.TextGenerationError({
            operation: request.operation,
            detail: "Unexpected invocation.",
          }),
        );
      };
      const runner = withMemoryExecution(
        { providerInstanceId: selection.instanceId, environmentId: M.EnvironmentId.make("owner") },
        M.ProviderDriverKind.make("codex"),
        selected,
      );
      const request = {
        operation: "generateMemorySummary" as const,
        cwd: summary.cwd,
        modelSelection: selection,
        ...(yield* buildMemorySummaryPrompt(summary)),
      };
      for (const extra of [{ attachments: [] }, { investigate: { timeoutMs: 10 } }])
        expect((yield* Effect.exit(runner({ ...request, ...extra })))._tag).toBe("Failure");
      expect(calls).toBe(0);
    }),
  );
});
