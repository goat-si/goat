import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type ThreadId,
} from "@goat/contracts";
import { getInitialServerConfig, request } from "../rpc/client.ts";

export class FreshContextUnavailableError extends Data.TaggedError("FreshContextUnavailableError")<{
  readonly message: string;
}> {}

export const supportsServerResolvedCommandContext = Effect.fn(
  "EnvironmentCommands.supportsServerResolvedCommandContext",
)(function* () {
  const config = yield* getInitialServerConfig();
  return config.environment.capabilities.serverResolvedCommandContext === true;
});

export const validateFreshContext = Effect.fn("EnvironmentCommands.validateFreshContext")(
  function* (input: { readonly freshContext?: boolean; readonly bootstrap?: unknown }) {
    if (!input.freshContext) return;
    const config = yield* getInitialServerConfig();
    if (config.environment.capabilities.freshContext !== true)
      return yield* new FreshContextUnavailableError({
        message: "This environment cannot start a fresh session.",
      });
    if (input.bootstrap !== undefined)
      return yield* new FreshContextUnavailableError({
        message: "A fresh session requires an existing thread.",
      });
  },
);

export const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

export const getProjection = (threadId: ThreadId) =>
  request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId });
