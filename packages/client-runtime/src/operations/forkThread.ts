import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadForkError,
  type OrchestrationV2ThreadForkInput,
  type OrchestrationV2ThreadForkResult,
  type OrchestrationV2ThreadForkSourcePoint,
  type RunId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import { request, requestGuarded } from "../rpc/client.ts";

export type ForkThreadInput = OrchestrationV2ThreadForkInput & {
  /** The source environment advertises threadForkWorkspace. */
  readonly serverForks: boolean;
};

/** A fork from one response's run, or from the thread's latest finished turn. */
export const threadForkSourcePoint = (runId?: RunId): OrchestrationV2ThreadForkSourcePoint =>
  runId === undefined ? { type: "latest_stable" } : { type: "run", runId };

/**
 * Forks through orchestration.forkThread where the server serves it. An older server can still
 * fork into the same checkout through a plain thread.fork; it cannot make a worktree.
 */
export const forkThread = Effect.fn("EnvironmentCommands.forkThread")(function* (
  input: ForkThreadInput,
) {
  const { serverForks, ...rpcInput } = input;
  if (serverForks) {
    return yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.forkThread, rpcInput);
  }
  if (input.workspace.type === "worktree") {
    return yield* new OrchestrationV2ThreadForkError({
      commandId: input.commandId,
      sourceThreadId: input.sourceThreadId,
      reason: "unsupported",
      message: "Update this server to fork into a new worktree.",
    });
  }
  const dispatched = yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    type: "thread.fork",
    commandId: input.commandId,
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    sourcePoint: input.sourcePoint,
    ...(input.title === undefined ? {} : { title: input.title }),
  }).pipe(
    Effect.catchTags({
      OrchestrationV2DispatchCommandError: (cause) =>
        Effect.fail(
          new OrchestrationV2ThreadForkError({
            commandId: input.commandId,
            sourceThreadId: input.sourceThreadId,
            reason: "fork_failed",
            message: cause.message,
            cause,
          }),
        ),
    }),
  );
  const result: OrchestrationV2ThreadForkResult = {
    sequence: dispatched.sequence,
    targetThreadId: input.targetThreadId,
  };
  return result;
});
