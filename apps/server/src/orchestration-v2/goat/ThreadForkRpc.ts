import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadForkError,
  type OrchestrationV2ThreadForkInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import { ThreadForkWorkspaceService } from "./ThreadForkWorkspace.ts";

/** The forkThread handler, kept here so ws.ts needs one line. */
export const threadForkRpcHandlers = Effect.fn("orchestrationV2.threadForkRpcHandlers")(function* (
  startup: Pick<ServerRuntimeStartup.ServerRuntimeStartup["Service"], "enqueueCommand">,
) {
  const forks = yield* ThreadForkWorkspaceService;
  return {
    [ORCHESTRATION_V2_WS_METHODS.forkThread]: (input: OrchestrationV2ThreadForkInput) =>
      Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId,
        "orchestration_v2.source_thread_id": input.sourceThreadId,
        "orchestration_v2.thread_id": input.targetThreadId,
        "orchestration_v2.fork_workspace": input.workspace.type,
      }).pipe(
        Effect.andThen(
          startup.enqueueCommand(
            forks.fork({
              commandId: input.commandId,
              sourceThreadId: input.sourceThreadId,
              targetThreadId: input.targetThreadId,
              sourcePoint: input.sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              workspace: input.workspace,
              createdBy: "user",
              creationSource: input.creationSource ?? "web",
            }),
          ),
        ),
        Effect.mapError((cause) =>
          isForkError(cause)
            ? cause
            : new OrchestrationV2ThreadForkError({
                commandId: input.commandId,
                sourceThreadId: input.sourceThreadId,
                reason: "fork_failed",
                message: "The server is still starting. Try again in a moment.",
                cause,
              }),
        ),
      ),
  };
});

const isForkError = Schema.is(OrchestrationV2ThreadForkError);
