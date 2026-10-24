import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RemoteReportToolkit } from "./tools.ts";

/**
 * A binding that is gone and a read key that does not match are permanent for
 * the caller: the origin coordinator reads these codes over the SSH transport
 * to stop following a dispatch instead of retrying it forever.
 */
export const remoteReportFailure = (error: RemoteReportService.RemoteReportError) =>
  error.reason === "idempotency_mismatch"
    ? new OrchestratorMcpFailure({
        code: "conflict",
        reason: "idempotency_mismatch",
        message:
          "This clientRequestId was already used for another report, so this call did not report. Use a new clientRequestId for a different report.",
      })
    : new OrchestratorMcpFailure({
        code:
          error.reason === "storage" || error.reason === "unavailable"
            ? "orchestration_error"
            : error.reason === "not_bound" || error.reason === "thread_deleted"
              ? "thread_not_found"
              : error.reason === "access_denied"
                ? "capability_denied"
                : error.reason === "run_not_found"
                  ? "run_not_found"
                  : error.reason === "fenced"
                    ? "conflict"
                    : "invalid_request",
        message:
          error.reason === "not_bound"
            ? "This thread has no origin to report to: it was not launched from another machine or by a thread on this machine."
            : error.reason === "thread_deleted"
              ? "The bound thread was deleted."
              : error.reason === "access_denied"
                ? "The report correlation or read key is invalid."
                : error.reason === "run_not_found"
                  ? "The watched run was not found."
                  : error.reason === "fenced"
                    ? "The origin fenced this correlation id after losing its launch; it can no longer bind."
                    : error.message,
      });
export const layer = McpToolAccess.toLayer(RemoteReportToolkit, {
  goat_origin_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "goat_origin_report");
      const reports = yield* RemoteReportService.RemoteReportService;
      return yield* reports
        .report(caller.thread.threadId, input)
        .pipe(Effect.mapError(remoteReportFailure));
    }),
  ),
  // The calling thread is the only scope: no argument can name another thread's receipts.
  goat_origin_report_receipt: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        scope,
        "goat_origin_report_receipt",
      );
      const reports = yield* RemoteReportService.RemoteReportService;
      return {
        receipt: yield* reports
          .receipt(caller.thread.threadId, input.clientRequestId)
          .pipe(Effect.mapError(remoteReportFailure)),
      };
    }),
  ),
  // The read key is its capability; the declaration refuses a read-only client before it deletes.
  goat_origin_reports_wait: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const reports = yield* RemoteReportService.RemoteReportService;
      return yield* reports.wait(input).pipe(Effect.mapError(remoteReportFailure));
    }),
  ),
  // Fencing is a durable write; the correlation's read key is the capability.
  goat_origin_resolve_binding: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const reports = yield* RemoteReportService.RemoteReportService;
      return yield* reports.resolveBinding(input).pipe(Effect.mapError(remoteReportFailure));
    }),
  ),
});
