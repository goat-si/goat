import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Routing from "../../../provider/ProviderDiagnosisRouting.ts";
import * as McpInvocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderToolkit } from "./tools.ts";
export const layer = McpToolAccess.toLayer(ProviderToolkit, {
  goat_provider_diagnose: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocation.McpInvocationContext;
      const routing = yield* Routing.ProviderDiagnosisRouting;
      return yield* routing.diagnose(input, { kind: "mcp", scope }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error._tag === "EnvironmentAuthorizationError"
                  ? "capability_denied"
                  : error._tag === "OrchestratorMcpFailure"
                    ? error.code
                    : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
