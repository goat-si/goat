import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ThreadResult, ThreadResultReport } from "./threadResult.ts";

it("retains explicit run and attempt relevance while rejecting unknown relevance and outcomes", () => {
  const decode = Schema.decodeUnknownSync(ThreadResultReport);
  const report = {
    runId: "run",
    expectedAttemptId: "attempt-A",
    outcome: "succeeded",
    notificationRelevance: "no_update",
  };
  expect(decode(report)).toEqual(report);
  expect(decode({ outcome: "succeeded" })).toEqual({ outcome: "succeeded" });
  expect(() => decode({ ...report, notificationRelevance: "future" })).toThrow();
  expect(() => decode({ outcome: "no_update" })).toThrow();
});

it("keeps old results readable and bounds attachment references", () => {
  const decodeReport = Schema.decodeUnknownSync(ThreadResultReport);
  const decodeResult = Schema.decodeUnknownSync(ThreadResult);
  const ref = { messageId: "message", attachmentId: "attachment" };
  const result = {
    runId: "run",
    runStatus: "completed",
    outcome: "succeeded",
    reportedAt: null,
    pullRequests: [],
    commits: [],
    branch: null,
  };
  expect(decodeResult(result)).toEqual(result);
  expect(
    decodeReport({ outcome: "succeeded", attachmentRefs: Array(8).fill(ref) }).attachmentRefs,
  ).toHaveLength(8);
  expect(() =>
    decodeReport({ outcome: "succeeded", attachmentRefs: Array(9).fill(ref) }),
  ).toThrow();
  const attachment = { ...ref, attemptId: "attempt", name: "result.xml" };
  const oldResult = ThreadResult.mapFields(Struct.omit(["attachments"]));
  expect(Schema.decodeUnknownSync(oldResult)({ ...result, attachments: [attachment] })).toEqual(
    result,
  );
  expect(
    decodeResult({ ...result, attachments: Array(128).fill(attachment) }).attachments,
  ).toHaveLength(128);
  expect(() => decodeResult({ ...result, attachments: Array(129).fill(attachment) })).toThrow();
});
