import { describe, expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ChannelReceptionModelOutput } from "./channelReceptionPrompt.ts";
import { buildMemoryConflictPrompt, buildMemorySummaryPrompt } from "./memoryGenerationPrompts.ts";
import { strictOutputSchemaViolations } from "./strictOutputSchema.ts";
import type { Operation } from "./textGenerationOperations.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import { toJsonSchemaObject, toStrictJsonSchemaObject } from "./textGenerationUtils.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const modelSelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("codex"),
  model: "alias",
  options: [],
});
const summaryInput = M.GenerateMemorySummaryInput.make({
  cwd: "scratch",
  sourceThread: { environmentId: M.EnvironmentId.make("env"), threadId: M.ThreadId.make("thread") },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic", completed: true }],
  modelSelection,
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
const conflictInput = M.ResolveMemoryConflictInput.make({
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
  modelSelection,
});

/** One schema per operation; a new operation fails to compile until it is listed here. */
const operationSchemas = Effect.gen(function* () {
  const schemas: Record<Operation, ReadonlyArray<Schema.Top>> = {
    generateCommitMessage: [false, true].map(
      (includeBranch) =>
        buildCommitMessagePrompt({
          branch: "main",
          stagedSummary: "M a.ts",
          stagedPatch: "diff",
          includeBranch,
        }).outputSchema,
    ),
    generatePrContent: [
      buildPrContentPrompt({
        baseBranch: "main",
        headBranch: "feature",
        commitSummary: "feat: x",
        diffSummary: "1 file",
        diffPatch: "diff",
      }).outputSchema,
    ],
    generateBranchName: [buildBranchNamePrompt({ message: "Add search" }).outputSchema],
    generateThreadTitle: [buildThreadTitlePrompt({ message: "Fix this" }).outputSchema],
    generateReviewGuide: [
      buildReviewGuidePrompt({
        number: 1,
        title: "Change",
        description: "",
        baseBranch: "main",
        baseCommit: "abc123",
        settledReview: "",
      }).outputSchema,
    ],
    generateChannelReception: [ChannelReceptionModelOutput],
    generateMemorySummary: [(yield* buildMemorySummaryPrompt(summaryInput)).outputSchema],
    resolveMemoryConflict: [(yield* buildMemoryConflictPrompt(conflictInput)).outputSchema],
  };
  return schemas;
});

describe("structured output schemas", () => {
  it.effect("every operation sends a schema strict structured output accepts", () =>
    Effect.gen(function* () {
      const schemas = yield* operationSchemas;
      for (const [operation, list] of Object.entries(schemas)) {
        for (const schema of list) {
          expect({
            operation,
            violations: strictOutputSchemaViolations(toJsonSchemaObject(schema)),
          }).toEqual({
            operation,
            violations: [],
          });
        }
      }
    }),
  );

  // Both messages are what Codex CLI 0.163.0 returned for these schemas.
  it("reports the two rejections the real CLI produced", () => {
    expect(strictOutputSchemaViolations({})).toEqual([
      "schema must be a JSON Schema of 'type: \"object\"', got 'type: \"None\"'.",
    ]);
    expect(
      strictOutputSchemaViolations({
        type: "object",
        properties: { answer: { type: "string" }, extra: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }),
    ).toEqual([
      "schema: 'required' is required to include every key in properties. Missing 'extra'.",
    ]);
  });

  // Codex CLI 0.163.0 accepted this schema and answered with each of these shapes.
  it("decodes the read, run_turn and follow_up answers a strict provider returns", () => {
    expect(strictOutputSchemaViolations(toJsonSchemaObject(ChannelReceptionModelOutput))).toEqual(
      [],
    );
    const empty = {
      replyText: "On it.",
      title: "",
      instruction: "",
      projectId: "",
      host: "",
      taskId: "",
      questionId: "",
      answer: "",
      question: "",
      options: [],
      clarifyAbout: "other",
      reads: [],
      remember: "",
      rememberQuote: "",
      notesChangeRequested: "",
      additionalTasks: [],
    };
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelReceptionModelOutput));
    for (const answer of [
      { ...empty, action: "read", reads: [{ kind: "memory", query: "deploy" }] },
      { ...empty, action: "run_turn", title: "Check disk", instruction: "Find what fills it." },
      { ...empty, action: "follow_up", taskId: "task:1" },
    ]) {
      expect(decode(JSON.stringify(answer), { onExcessProperty: "error" }).action).toBe(
        answer.action,
      );
    }
  });

  it("checks nested objects, $defs, and refs", () => {
    expect(
      strictOutputSchemaViolations({
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/$defs/Item" } },
          other: { $ref: "https://example.com/schema" },
        },
        required: ["items", "other"],
        additionalProperties: false,
        $defs: { Item: { type: "object", properties: { a: { type: "string" } }, required: [] } },
      }),
    ).toEqual([
      "schema/properties/other: $ref must point into #/$defs, got https://example.com/schema.",
      "schema/$defs/Item: 'additionalProperties' is required to be supplied and to be false.",
      "schema/$defs/Item: 'required' is required to include every key in properties. Missing 'a'.",
    ]);
  });

  it.effect("refuses the memory contract schemas before they reach a provider", () =>
    Effect.gen(function* () {
      expect(toJsonSchemaObject(M.GenerateMemorySummaryResult)).toEqual({});
      const error = yield* toStrictJsonSchemaObject(
        "generateMemorySummary",
        M.GenerateMemorySummaryResult,
      ).pipe(Effect.asVoid, Effect.flip);
      expect(error.detail).toContain("got 'type: \"None\"'");
    }),
  );
});
