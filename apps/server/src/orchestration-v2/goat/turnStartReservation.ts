import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { RunId, ThreadId } from "@goat/contracts";

import * as ProjectService from "../../project/ProjectService.ts";
import { tryTurnStartReservation } from "../../workspace/checkpointRestoreReservation.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";
import { WorkspaceLeaseBusyError } from "./WorkspaceLeaseBusyError.ts";

/**
 * Runs a turn's startup outside any file restore that overlaps its folder (its worktree, else
 * the project root). An overlapping restore sends the start back to the outbox retry.
 */
export const makeTurnStartReservation = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  return <A, E, R>(
    input: { readonly threadId: ThreadId; readonly runId: RunId },
    startup: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* projectionStore.getThreadShell(input.threadId).pipe(Effect.option),
      );
      const cwd =
        thread?.worktreePath ??
        (thread === undefined
          ? undefined
          : yield* projects.getById(thread.projectId, { includeDeleted: true }).pipe(
              Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
              Effect.orElseSucceed(() => undefined),
            ));
      if (cwd === undefined) return yield* startup;
      const started = yield* tryTurnStartReservation(fileSystem, path, path.resolve(cwd), startup);
      if (Option.isSome(started)) return started.value;
      return yield* new ProviderTurnStartError({
        runId: input.runId,
        cause: new WorkspaceLeaseBusyError({}),
      });
    });
});
