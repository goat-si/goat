import { ORCHESTRATION_V2_WS_METHODS, type OrchestrationV2Command } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";

export const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

export const dispatchMessage = Effect.fn("EnvironmentCommands.dispatchMessage")(function* (
  command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* dispatch(command).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: `${supervisor.target.label} did not confirm the message within 60 seconds.`,
          }),
        ),
    }),
  );
});
