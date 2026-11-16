import type { CommandId, ThreadId } from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import type * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

type Tagged = { readonly _tag: string };

/**
 * After a delegation commits: binds its child work, prepares its child run, then updates its lane
 * reservation on every exit, because a pending local reservation holds a lane until it is updated.
 */
export const settleDelegatedChild = <E1 extends Tagged, E2 extends Tagged>(input: {
  readonly commandId: CommandId;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly launches: ThreadLaunchService.ThreadLaunchService["Service"];
  readonly bind: (threadId: ThreadId) => Effect.Effect<void, E1>;
  readonly completeLane: Effect.Effect<void, E2>;
}) => {
  const threadId = derive.delegatedTaskThread({ commandId: input.commandId });
  return Effect.gen(function* () {
    yield* input.bind(threadId);
    for (const run of (yield* input.threads.getThreadRecords(threadId, ["runs"])).runs)
      if (run.status === "preparing" && run.workspacePreparation !== undefined)
        yield* input.launches.prepareRun({ commandId: input.commandId, threadId, runId: run.id });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not prepare a delegated child run", { tag: error._tag }),
    ),
    Effect.ensuring(
      input.completeLane.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not update a delegation's lane reservation", {
            tag: error._tag,
          }),
        ),
      ),
    ),
  );
};
