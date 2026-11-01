import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const addDevice = McpToolAccess.writes((input: SshDeviceAdd.SshDeviceAddInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const service = yield* SshDeviceAdd.SshDeviceAdd;
    return yield* service.addDevice(input, { kind: "mcp", scope }).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorMcpFailure"
          ? error
          : new OrchestratorMcpFailure({
              code:
                error._tag === "EnvironmentAuthorizationError"
                  ? "capability_denied"
                  : error._tag === "SshHostProbeError" && error.reason === "invalid_request"
                    ? "invalid_request"
                    : "orchestration_error",
              message: error.message,
            }),
      ),
    );
  }),
);
