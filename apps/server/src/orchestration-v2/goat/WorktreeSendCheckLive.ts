import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import * as ProjectStore from "../ProjectStore.ts";
import {
  WorktreeSendCheck,
  worktreeSendRefusal,
  type SendCheckReads,
  type SendTarget,
} from "./WorktreeSendCheck.ts";

/** Kept apart from the service tag so ThreadManagementService imports no settings or stores. */
export const layer = Layer.effect(
  WorktreeSendCheck,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
    const reads: SendCheckReads = {
      // An unreadable folder is left to turn start, as today.
      exists: (worktreePath) =>
        fs.exists(path.resolve(worktreePath)).pipe(Effect.orElseSucceed(() => true)),
      isManaged: (worktreePath) => isManagedWorktreePath(path.resolve(worktreePath)),
      projectExists: (projectId) =>
        projects.get(projectId).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => true),
        ),
    };
    return WorktreeSendCheck.of({
      refusal: Effect.fn("WorktreeSendCheck.check")(function* (thread: SendTarget) {
        return yield* worktreeSendRefusal(reads, thread);
      }),
    });
  }),
);
