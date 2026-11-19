import { assert, it } from "@effect/vitest";
import { NodeId, ScheduledTaskId } from "@goat/contracts";
import { memoryRun, memoryMessage } from "./RunMemoryFixtures.testkit.ts";
import * as RunExecutionService from "./RunExecutionService.ts";

it.each([
  { name: "web user", source: "web", expected: null },
  { name: "mobile user", source: "mobile", expected: null },
  ...(["server", "mcp", "provider"] as const).flatMap((source) => [
    { name: `${source} user without ceiling`, source, expected: "none" },
    {
      name: `${source} user with read ceiling`,
      source,
      ceiling: "read",
      expected: "read",
    } as const,
  ]),
  { name: "agent", source: "web", author: "agent", expected: "none" },
  { name: "system", source: "web", author: "system", expected: "none" },
  { name: "scheduled", source: "web", scheduled: true, ceiling: "read", expected: "read" },
  { name: "delegated", source: "mobile", delegated: true, ceiling: "read", expected: "read" },
  { name: "legacy task", source: "server", delegated: true, expected: "none" },
] as const)("memory prepare classification: $name", (testCase) => {
  const run = memoryRun(1, {
    ...("ceiling" in testCase ? { memoryGrantCeiling: testCase.ceiling } : {}),
    ...("delegated" in testCase ? { delegatedTaskId: NodeId.make("memory-task") } : {}),
  });
  const message = memoryMessage(run, {
    creationSource: testCase.source,
    createdBy: "author" in testCase ? testCase.author : "user",
    ...("scheduled" in testCase
      ? { scheduledTaskId: ScheduledTaskId.make("memory-schedule") }
      : {}),
  });
  assert.deepEqual(
    RunExecutionService.runMemoryPrepareInput({
      run,
      message,
      projection: { runs: [run], messages: [message] },
    }),
    { memoryGrantCeiling: testCase.expected },
  );
});
it.each(["usageLimitContinuationOfRunId", "restartContinuationOfRunId"] as const)(
  "memory prepare ancestry: %s",
  (field) => {
    for (const delegated of [false, true]) {
      const source = memoryRun(
        1,
        delegated
          ? { delegatedTaskId: NodeId.make("memory-task"), memoryGrantCeiling: "read" }
          : {},
      );
      const sourceMessage = memoryMessage(source);
      const run = memoryRun(2, { [field]: source.id, memoryGrantCeiling: "read_write" });
      const message = memoryMessage(run, { creationSource: "server" });
      const projection = { runs: [source, run], messages: [sourceMessage, message] };
      assert.deepEqual(RunExecutionService.runMemoryPrepareInput({ run, message, projection }), {
        memoryGrantCeiling: delegated ? "read" : null,
      });
      assert.deepEqual(
        RunExecutionService.runMemoryPrepareInput({
          run,
          message,
          projection: { ...projection, runs: [run] },
        }),
        { memoryGrantCeiling: "none" },
      );
      assert.deepEqual(
        RunExecutionService.runMemoryPrepareInput({
          run,
          message,
          projection: { ...projection, messages: [message] },
        }),
        { memoryGrantCeiling: "none" },
      );
    }
    const runs = [memoryRun(1)];
    for (let index = 2; index <= 5; index++)
      runs.push(
        memoryRun(index, {
          [index % 2 ? "restartContinuationOfRunId" : "usageLimitContinuationOfRunId"]:
            runs.at(-1)!.id,
        }),
      );
    const messages = runs.map((run) =>
      memoryMessage(run, { creationSource: run.ordinal === 1 ? "web" : "server" }),
    );
    assert.deepEqual(
      RunExecutionService.runMemoryPrepareInput({
        run: runs[3]!,
        message: messages[3]!,
        projection: { runs, messages },
      }),
      { memoryGrantCeiling: null },
    );
    assert.deepEqual(
      RunExecutionService.runMemoryPrepareInput({
        run: runs[4]!,
        message: messages[4]!,
        projection: { runs, messages },
      }),
      { memoryGrantCeiling: "none" },
    );
    const cyclic = memoryRun(1, { [field]: runs[0]!.id });
    assert.deepEqual(
      RunExecutionService.runMemoryPrepareInput({
        run: cyclic,
        message: messages[0]!,
        projection: { runs: [cyclic], messages },
      }),
      { memoryGrantCeiling: "none" },
    );
  },
);
