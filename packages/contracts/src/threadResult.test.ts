import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadResultReport } from "./threadResult.ts";

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
