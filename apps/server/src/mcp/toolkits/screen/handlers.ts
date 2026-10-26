import { RunId } from "@goat/contracts";
import type { ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScreenRunService from "../../../screenCode/ScreenRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ScreenToolkit } from "./tools.ts";

const refusal = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});

export const layer = McpToolAccess.toLayer(ScreenToolkit, {
  goat_screen_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.thread === undefined)
        return yield* Effect.fail(
          refusal("permission_denied", "Run this tool from a GOAT thread."),
        );
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* threads
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError(() => refusal("permission_denied", "Refresh this GOAT thread.")));
      if (shell?.activeRunId === null || shell?.activeRunId === undefined)
        return yield* Effect.fail(refusal("permission_denied", "Start a live GOAT turn."));
      const records = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs"], {
          runIds: [RunId.make(shell.activeRunId)],
        })
        .pipe(Effect.mapError(() => refusal("permission_denied", "Refresh this GOAT turn.")));
      const run = records.runs.find((candidate) => candidate.id === shell.activeRunId);
      if (
        run?.activeAttemptId === null ||
        run?.activeAttemptId === undefined ||
        run.providerInstanceId !== scope.thread.providerInstanceId ||
        run.status !== "running"
      )
        return yield* Effect.fail(refusal("permission_denied", "Start a live GOAT turn."));
      const service = yield* ScreenRunService.ScreenRunService;
      return yield* service.runCell({
        runId: run.id,
        turnId: run.activeAttemptId,
        threadId: scope.thread.threadId,
        environmentId: scope.environmentId,
        invocation: scope as McpInvocationContext.McpThreadInvocationScope,
        ...(scope.screenBindingHints === undefined
          ? {}
          : { bindingHints: scope.screenBindingHints }),
        source: input.code,
        ...(input.reset === undefined ? {} : { resetValues: input.reset }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      });
    }),
  ),
});
