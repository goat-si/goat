import { OrchestrationV2ThreadForkError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadForkWorkspace from "../orchestration-v2/goat/ThreadForkWorkspace.ts";

/**
 * Thread-starting doubles for tests that assemble MCP toolkits: launches are inert, and a fork
 * dispatches thread.fork through the test's ThreadManagementService, as a same-checkout fork does.
 */
export const layerThreadStartMocks = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.effect(
    ThreadForkWorkspace.ThreadForkWorkspaceService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return ThreadForkWorkspace.ThreadForkWorkspaceService.of({
        fork: (input) =>
          threads
            .dispatch({
              type: "thread.fork",
              commandId: input.commandId,
              sourceThreadId: input.sourceThreadId,
              targetThreadId: input.targetThreadId,
              sourcePoint: input.sourcePoint,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(
              Effect.map((result) => ({
                sequence: result.sequence,
                targetThreadId: input.targetThreadId,
              })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2ThreadForkError({
                    commandId: input.commandId,
                    sourceThreadId: input.sourceThreadId,
                    reason: "fork_failed",
                    message: cause.message,
                    cause,
                  }),
              ),
            ),
      });
    }),
  ),
);
