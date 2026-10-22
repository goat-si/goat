import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { requestComputerUse } from "../../../cua/ComputerUseRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ComputerUseToolkit, {
  goat_computer_use_request: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(
        scope,
        "goat_computer_use_request",
      );
      return yield* requestComputerUse({
        threadId: caller.thread.threadId,
        providerInstanceId: caller.thread.providerInstanceId,
        request: input,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                cause instanceof Error && cause.message.length > 0
                  ? cause.message
                  : "Could not request computer use. Try again.",
            }),
        ),
      );
    }),
  ),
});
