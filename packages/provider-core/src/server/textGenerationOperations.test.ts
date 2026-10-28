import { describe, expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
const revision = M.MemoryRevision.make({
  memorySpaceId: M.MemorySpaceId.make(id(1)),
  memoryId: M.MemoryId.make(id(2)),
  revisionId: M.MemoryRevisionId.make(id(3)),
  operationId: M.MemoryOperationId.make(id(4)),
  payloadRef: M.MemoryRevisionId.make(id(3)),
  parents: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  provenance: { environmentId: M.EnvironmentId.make("env") },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
});
const payload = M.MemoryPayload.make({
  text: "Synthetic",
  evidence: [],
  derivedFromMemoryRevisions: [],
});
const conflict = M.ResolveMemoryConflictInput.make({
  cwd: "scratch",
  memorySpaceId: revision.memorySpaceId,
  memoryId: revision.memoryId,
  conflictId: M.MemoryConflictId.make(id(8)),
  heads: [
    { revision, payload },
    {
      revision: {
        ...revision,
        revisionId: M.MemoryRevisionId.make(id(5)),
        payloadRef: M.MemoryRevisionId.make(id(5)),
      },
      payload,
    },
  ],
  modelSelection: selection,
});
const result = { text: "Synthetic result", assertionKind: "inference" as const, evidence: [] };

import { fromRunner, outputDecodeOptions, type Runner } from "./textGenerationOperations.ts";
import { withMemoryExecution, type MemorySelectedRunner } from "./memoryGenerationRunner.ts";
describe("memory shared operations", () => {
  const legacy: Runner = (request) =>
    Schema.decodeUnknownEffect(request.outputSchema)(
      request.operation === "generateThreadTitle"
        ? { title: "  Synthetic title  " }
        : request.operation === "generateCommitMessage"
          ? { subject: "Synthetic subject", body: "  Body  " }
          : { title: "Review", summary: "Synthetic" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new M.TextGenerationError({
            operation: request.operation,
            detail: "Fixture decode failed.",
            cause,
          }),
      ),
    );
  it.effect("memory operations omit investigation and attachments", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const selected: MemorySelectedRunner = (request) => {
        expect(request.attachments).toBeUndefined();
        expect(request.investigate).toBeUndefined();
        seen.push(request.operation);
        return Schema.decodeUnknownEffect(request.outputSchema)(
          request.operation === "resolveMemoryConflict"
            ? { ...result, judgment: "Synthetic judgment" }
            : { summary: result },
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
      };
      const provider = fromRunner("fixture", legacy, {
        memoryRunner: withMemoryExecution(
          {
            providerInstanceId: selection.instanceId,
            environmentId: M.EnvironmentId.make("owner"),
          },
          M.ProviderDriverKind.make("codex"),
          selected,
        ),
      });
      yield* provider.resolveMemoryConflict!(conflict);
      yield* provider.generateMemorySummary!(summary);
      expect(seen).toEqual(["resolveMemoryConflict", "generateMemorySummary"]);
    }),
  );
  it.effect("decodes both memory result schemas", () =>
    Effect.gen(function* () {
      const selected: MemorySelectedRunner = (request) =>
        Schema.decodeUnknownEffect(request.outputSchema)(
          { ...result, judgment: "Synthetic judgment", authority: "forged" },
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
      const provider = fromRunner("fixture", legacy, {
        memoryRunner: withMemoryExecution(
          {
            providerInstanceId: selection.instanceId,
            environmentId: M.EnvironmentId.make("owner"),
          },
          M.ProviderDriverKind.make("codex"),
          selected,
        ),
      });
      expect((yield* Effect.exit(provider.resolveMemoryConflict!(conflict)))._tag).toBe("Failure");
      expect((yield* Effect.exit(provider.generateMemorySummary!(summary)))._tag).toBe("Failure");
    }),
  );
  it.effect("turns the model's null references into contract evidence", () =>
    Effect.gen(function* () {
      const importSourceId = M.MemoryImportSourceId.make(id(9));
      const input = M.GenerateMemorySummaryInput.make({
        ...summary,
        previousSummary: M.MemoryPayload.make({
          text: "Earlier",
          evidence: [{ origin: "import", importSourceId, messageIds: [] }],
          derivedFromMemoryRevisions: [],
        }),
      });
      const raw = JSON.stringify({
        summary: {
          text: "Durable fact",
          assertionKind: "fact",
          evidence: [
            {
              origin: "thread",
              sourceThread: summary.sourceThread,
              watermark: summary.sourceWatermark,
              messageIds: ["m1"],
              importSourceId: null,
            },
            {
              origin: "import",
              sourceThread: null,
              watermark: null,
              messageIds: [],
              importSourceId,
            },
            {
              origin: "model",
              sourceThread: null,
              watermark: null,
              messageIds: [],
              importSourceId: null,
            },
          ],
        },
      });
      const selected: MemorySelectedRunner = (request) =>
        Schema.decodeEffect(Schema.fromJsonString(request.outputSchema))(
          raw,
          outputDecodeOptions(request.operation),
        ).pipe(
          Effect.map((result) => ({ result, effectiveModel: "effective" })),
          Effect.mapError(
            (cause) =>
              new M.TextGenerationError({ operation: request.operation, detail: "decode", cause }),
          ),
        );
      const provider = fromRunner("fixture", legacy, {
        memoryRunner: withMemoryExecution(
          {
            providerInstanceId: selection.instanceId,
            environmentId: M.EnvironmentId.make("owner"),
          },
          M.ProviderDriverKind.make("codex"),
          selected,
        ),
      });
      const generated = yield* provider.generateMemorySummary!(input);
      expect(generated.result?.evidence).toEqual([
        {
          origin: "thread",
          sourceThread: summary.sourceThread,
          watermark: summary.sourceWatermark,
          messageIds: ["m1"],
        },
        { origin: "import", messageIds: [], importSourceId },
        { origin: "model", messageIds: [] },
      ]);
    }),
  );
  it.effect(
    "answers null when the model finds nothing durable, explicitly or in legacy prose",
    () =>
      Effect.gen(function* () {
        const answer =
          (summary: unknown): MemorySelectedRunner =>
          (request) =>
            Schema.decodeUnknownEffect(request.outputSchema)(
              { summary },
              outputDecodeOptions(request.operation),
            ).pipe(
              Effect.map((result) => ({ result, effectiveModel: "effective" })),
              Effect.mapError(
                (cause) =>
                  new M.TextGenerationError({
                    operation: request.operation,
                    detail: "decode",
                    cause,
                  }),
              ),
            );
        const generate = (summaryAnswer: unknown) =>
          fromRunner("fixture", legacy, {
            memoryRunner: withMemoryExecution(
              {
                providerInstanceId: selection.instanceId,
                environmentId: M.EnvironmentId.make("owner"),
              },
              M.ProviderDriverKind.make("codex"),
              answer(summaryAnswer),
            ),
          }).generateMemorySummary!(summary);
        expect((yield* generate(null)).result).toBeNull();
        const prose = (text: string) => ({ text, assertionKind: "inference", evidence: [] });
        expect(
          (yield* generate(
            prose(
              "No durable preferences, decisions, recurring constraints, or verified results are present; the messages describe a one-off connectivity check.",
            ),
          )).result,
        ).toBeNull();
        // A text that also reports a verified result is kept.
        const kept =
          "No durable preferences were established. Verified result: the suite has no safe pruning.";
        expect((yield* generate(prose(kept))).result?.text).toBe(kept);
        // A real constraint that happens to start the same way is not a no-op.
        const constraint =
          "No durable storage is available; all state must be committed to the remote database.";
        expect((yield* generate(prose(constraint))).result?.text).toBe(constraint);
      }),
  );
  it.effect("absent memoryRunner never invokes the legacy runner", () =>
    Effect.gen(function* () {
      let calls = 0;
      const run: Runner = (request) => {
        calls++;
        return legacy(request);
      };
      const provider = fromRunner("fixture", run);
      expect((yield* Effect.exit(provider.resolveMemoryConflict!(conflict)))._tag).toBe("Failure");
      expect((yield* Effect.exit(provider.generateMemorySummary!(summary)))._tag).toBe("Failure");
      expect(calls).toBe(0);
    }),
  );
  it.effect("keeps existing generation results compatible", () =>
    Effect.gen(function* () {
      const provider = fromRunner("fixture", legacy);
      expect(
        yield* provider.generateThreadTitle({
          cwd: "scratch",
          message: "Synthetic",
          modelSelection: selection,
        }),
      ).toEqual({ title: "Synthetic title" });
      expect(
        yield* provider.generateCommitMessage({
          cwd: "scratch",
          branch: null,
          stagedSummary: "Synthetic",
          stagedPatch: "",
          modelSelection: selection,
        }),
      ).toEqual({ subject: "Synthetic subject", body: "Body" });
    }),
  );
});
