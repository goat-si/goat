import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as M from "@goat/contracts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const selection = {
  instanceId: "codex",
  model: "alias",
  options: [
    { id: "effort", value: "high" },
    { id: "flag", value: false },
  ],
};
const thread = { environmentId: "env", threadId: "thread" };
const watermark = { fromEventId: "e1", toEventId: "e2", throughSequence: 2 };
const evidence = { origin: "thread", sourceThread: thread, watermark, messageIds: ["m1"] };
const payload = { text: "Synthetic", evidence: [evidence], derivedFromMemoryRevisions: [] };
const revision = {
  memorySpaceId: id(1),
  memoryId: id(2),
  revisionId: id(3),
  operationId: id(4),
  parents: [],
  scope: { kind: "user" },
  payloadRef: id(3),
  assertionKind: "fact",
  provenance: { environmentId: "env" },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
};
const resolve = {
  cwd: "scratch",
  memorySpaceId: id(1),
  memoryId: id(2),
  conflictId: id(8),
  heads: [
    { revision, payload },
    { revision: { ...revision, revisionId: id(5), payloadRef: id(5) }, payload },
  ],
  modelSelection: selection,
};
const summary = {
  cwd: "scratch",
  sourceThread: thread,
  sourceWatermark: watermark,
  messages: [{ messageId: "m1", text: "Synthetic", completed: true }],
  modelSelection: selection,
};
const result = { text: "Synthetic summary", assertionKind: "fact", evidence: [evidence] };
const decodeResolve = Schema.decodeUnknownSync(M.ResolveMemoryConflictInput);
const decodeSummary = Schema.decodeUnknownSync(M.GenerateMemorySummaryInput);
const decodeResult = Schema.decodeUnknownSync(M.GenerateMemorySummaryResult);
const decodeResolutionResult = Schema.decodeUnknownSync(M.ResolveMemoryConflictResult);
const decodeExecution = Schema.decodeUnknownSync(M.GenerateMemorySummaryExecutionResult);
const resolveJson = Schema.fromJsonString(M.ResolveMemoryConflictInput);
const encodeResolveJson = Schema.encodeSync(resolveJson);
const decodeResolveJson = Schema.decodeUnknownSync(resolveJson);
describe("memory generation contracts", () => {
  it("round-trips resolve inputs with complete model options", () => {
    const input = decodeResolve(resolve);
    expect(decodeResolveJson(encodeResolveJson(input)).modelSelection).toEqual(selection);
  });
  it("rejects head scope mismatch", () => {
    expect(() =>
      decodeResolve({
        ...resolve,
        heads: [
          resolve.heads[0],
          {
            revision: {
              ...resolve.heads[1]!.revision,
              scope: {
                kind: "project",
                projectKey: { kind: "explicit", sharedProjectId: "other" },
              },
            },
            payload,
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects resolution output with forged source evidence", () => {
    const input = decodeResolve(resolve);
    const forged = decodeResolutionResult({
      ...result,
      judgment: "Decision",
      evidence: [{ ...evidence, messageIds: ["unknown"] }],
    });
    expect(M.validateMemoryGenerationResult(input, forged)).toBe(false);
  });
  it("rejects summary output with unknown message ids", () => {
    const input = decodeSummary(summary);
    expect(
      M.validateMemoryGenerationResult(
        input,
        decodeResult({ ...result, evidence: [{ ...evidence, messageIds: ["unknown"] }] }),
      ),
    ).toBe(false);
    expect(M.validateMemoryGenerationResult(input, decodeResult(result))).toBe(true);
    expect(
      M.validateMemoryGenerationResult(
        decodeSummary({
          ...summary,
          messages: [{ messageId: "m1", text: "unfinished", completed: false }],
        }),
        decodeResult(result),
      ),
    ).toBe(false);
  });
  it("separates model result from runner execution metadata", () => {
    const execution = {
      requestedModelSelection: selection,
      effectiveProvider: "codex",
      effectiveModel: "effective",
      providerInstanceId: "codex",
      environmentId: "env",
    };
    expect(decodeExecution({ result, execution }).execution.requestedModelSelection).toEqual(
      selection,
    );
    expect(() => decodeResult({ ...result, execution })).toThrow();
    expect(() =>
      decodeExecution({ result, execution: { ...execution, providerInstanceId: "other" } }),
    ).toThrow();
  });
  it("does not accept model chosen revision ids", () => {
    expect(() => decodeResult({ ...result, revisionId: id(3) })).toThrow();
    expect(() =>
      decodeResolutionResult({ ...result, judgment: "Decision", fencingToken: 1 }),
    ).toThrow();
  });
});
