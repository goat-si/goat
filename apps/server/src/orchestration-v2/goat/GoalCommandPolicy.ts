import {
  parseGoalCommand,
  type ChatAttachment,
  type OrchestrationV2ServerCommand,
  type ProviderInstanceId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { OrchestratorDispatchError } from "../Orchestrator.ts";
import type { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";

export const makeGoalCommandPolicy = (input: {
  readonly providerAdapters: Pick<ProviderAdapterRegistryV2["Service"], "get">;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
}) => {
  const mapError = (command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">) =>
    Effect.mapError(
      (cause: unknown) =>
        new input.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause,
        }),
    );
  /** The driver when this provider runs `/goal` natively, else undefined. */
  const goalDriverFor = Effect.fn("Orchestrator.goalDriverFor")(function* (
    command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">,
    providerInstanceId: ProviderInstanceId,
  ) {
    const adapter = yield* input.providerAdapters.get(providerInstanceId).pipe(mapError(command));
    const { driver } = adapter;
    if (driver === "opencode" || driver === "antigravity") {
      const capabilities = yield* adapter.getCapabilities().pipe(mapError(command));
      return capabilities.turns.supportsNativeGoals === true ? driver : undefined;
    }
    return driver === "codex" || driver === "claudeAgent" ? driver : undefined;
  });

  /** Unsupported goal controls can become new objectives in native providers. */
  const ensureGoalCommandSupported = Effect.fn("Orchestrator.ensureGoalCommandSupported")(
    function* (
      command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">,
      message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
      providerInstanceId: ProviderInstanceId,
    ) {
      const goalCommand = parseGoalCommand(message);
      if (goalCommand === null || goalCommand.type === "set") return;
      const driver = yield* goalDriverFor(command, providerInstanceId);
      if (driver === "antigravity") {
        return yield* new input.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "Antigravity accepts /goal followed by an objective. Interrupt the running turn, then ask Antigravity to stop the current goal.",
        });
      }
      if (goalCommand.type !== "pause" && goalCommand.type !== "resume") return;
      if (driver !== "claudeAgent") return;
      return yield* new input.OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.",
      });
    },
  );

  return { goalDriverFor, ensureGoalCommandSupported };
};
