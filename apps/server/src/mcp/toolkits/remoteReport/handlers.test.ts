import { expect, it } from "@effect/vitest";
import type { OrchestratorMcpFailureCode } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import { remoteReportFailure } from "./handlers.ts";

// The origin coordinator decides from these codes whether to keep following a
// dispatch, so a reason that is permanent for the caller must not arrive as a
// retryable one (RemoteDispatchCoordinator's lost-task check).
const expected: Record<
  RemoteReportService.RemoteReportError["reason"],
  OrchestratorMcpFailureCode
> = {
  not_bound: "thread_not_found",
  thread_deleted: "thread_not_found",
  access_denied: "capability_denied",
  run_not_found: "run_not_found",
  storage: "orchestration_error",
  unavailable: "orchestration_error",
  invalid_request: "invalid_request",
  relay_unsupported: "invalid_request",
  relay_queue_full: "invalid_request",
  fenced: "conflict",
};

it.each(Object.entries(expected))("maps %s to %s", (reason, code) => {
  const failure = remoteReportFailure(
    new RemoteReportService.RemoteReportError({
      reason: reason as RemoteReportService.RemoteReportError["reason"],
    }),
  );
  expect(failure.code).toBe(code);
  expect(failure.message.length).toBeGreaterThan(0);
});

it.effect("keeps the permanent codes the coordinator treats as a lost task", () =>
  Effect.sync(() => {
    expect([expected.not_bound, expected.access_denied]).toEqual([
      "thread_not_found",
      "capability_denied",
    ]);
  }),
);
