import { assert, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";

it("ProviderSessionManagerV2 counts a delegated task as a wake only while its result can be delivered", () => {
  const runId = RunId.make("run-delegating");
  const thread = { archivedAt: null, deletedAt: null };
  const task = {
    origin: "app_owned" as const,
    status: "running" as const,
    runId,
    completionDelivery: undefined,
  };
  const run = (disposition: "open" | "disposed") => ({
    id: runId,
    delegatedCompletion: { disposition, nextGeneration: 1, delivery: null },
  });
  assert.isTrue(
    ProviderSessionManager.delegatedTaskWillWake({
      thread,
      runs: [run("open")],
      subagents: [task],
    }),
  );
  // An interrupted completion wake disposes the cohort, so the result never wakes the thread.
  assert.isFalse(
    ProviderSessionManager.delegatedTaskWillWake({
      thread,
      runs: [run("disposed")],
      subagents: [task],
    }),
  );
  assert.isFalse(
    ProviderSessionManager.delegatedTaskWillWake({
      thread,
      runs: [run("open")],
      subagents: [{ ...task, origin: "provider_native" }],
    }),
  );
});
