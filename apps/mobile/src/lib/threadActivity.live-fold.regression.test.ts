import { RunId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { deriveThreadFeedPresentation } from "./threadActivity";

it("holds the working run's fold slot before its activity arrives", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const runId = RunId.make("run-1");
  const rows = deriveThreadFeedPresentation(
    [],
    {
      runId,
      status: "running",
      startedAt,
      completedAt: null,
    },
    new Set(),
    new Set(),
    startedAt,
  );
  expect(rows.find((row) => row.id === `run-fold:${runId}`)).toMatchObject({
    type: "run-fold",
    workingSince: startedAt,
  });
});
