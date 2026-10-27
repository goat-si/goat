import { OrchestratorMcpFailure, ServerSettingsError } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { requestComputerUse } from "../../../cua/ComputerUseRequests.ts";
import * as ComputerUseSettings from "../../../cua/ComputerUseSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseToolkit } from "./tools.ts";

const WAIT_FOR_ANSWER = Duration.minutes(10);
/** settingsPath of the error the commit-time grant check raises, told apart from real failures. */
const CLIENT_REVOKED = "mcp:computer-use-client-revoked";

export const layer = McpToolAccess.toLayer(ComputerUseToolkit, {
  goat_computer_use_update: McpToolAccess.writesWithCapability(({ enabled }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const denied = () =>
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Computer use settings require an outside MCP client with live settings:write access.",
        });
      if (
        scope.thread !== undefined ||
        scope.client === undefined ||
        !scope.grantedScopes?.includes("settings:write") ||
        !scope.reauthorize
      )
        return yield* denied();
      yield* scope.reauthorize(["settings:write"]).pipe(Effect.mapError(denied));
      const authorizeAtCommit = scope.reauthorize(["settings:write"]).pipe(
        Effect.mapError(
          () =>
            new ServerSettingsError({
              settingsPath: CLIENT_REVOKED,
              operation: "enable-computer-use",
            }),
        ),
      );
      return yield* ComputerUseSettings.setEnabled(enabled, authorizeAtCommit).pipe(
        Effect.mapError((error) =>
          error.settingsPath === CLIENT_REVOKED
            ? denied()
            : new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              }),
        ),
      );
    }),
  ),
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
        // Like the other GOAT waits for a person, bounded well inside providers' tool timeouts.
        wait: WAIT_FOR_ANSWER,
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
