import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MARKER = "goat-restore-pending";

/** Where an unfinished restore stopped: the checks its setup and verification still owe. */
export const RestorePendingState = Schema.Struct({
  restoredFrom: Schema.Literals(["snapshot", "branch", "remote-branch", "base"]),
  headSha: Schema.String,
  snapshotSha: Schema.NullOr(Schema.String),
  snapshotRef: Schema.NullOr(Schema.String),
});
export type RestorePendingState = typeof RestorePendingState.Type;

export class RestorePendingError extends Schema.TaggedError<RestorePendingError>()(
  "RestorePendingError",
  { worktreePath: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not record that the restore of ${this.worktreePath} is unfinished.`;
  }
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RestorePendingState));

/**
 * A restored worktree stays marked until setup and verification succeed. The marker lives in the
 * linked worktree's Git admin folder, so it survives a restart and a rollback that could not
 * delete the folder, and leaves with the folder when removal works.
 */
export const makeRestorePending = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((pointer) =>
        pointer.startsWith("gitdir:")
          ? path.join(path.resolve(worktreePath, pointer.slice(7).trim()), MARKER)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );
  const marked = Effect.fn("RestorePending.marked")(function* (worktreePath: string) {
    const linked = yield* fs
      .exists(path.join(worktreePath, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    const marker = linked ? yield* markerPath(worktreePath) : null;
    if (marker === null) return false;
    return yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => false));
  });
  return {
    marked,
    /** Present and not waiting on an unfinished restore; an unreadable folder counts as present. */
    ready: Effect.fn("RestorePending.ready")(function* (worktreePath: string) {
      if (!(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true)))) return false;
      return !(yield* marked(worktreePath));
    }),
    read: (worktreePath: string) =>
      markerPath(worktreePath).pipe(
        Effect.flatMap((marker) =>
          marker === null ? Effect.succeed(null) : fs.readFileString(marker),
        ),
        Effect.flatMap((json) => (json === null ? Effect.succeed(null) : decode(json))),
        Effect.orElseSucceed(() => null),
      ),
    write: (worktreePath: string, state: RestorePendingState) =>
      markerPath(worktreePath).pipe(
        Effect.flatMap((marker) =>
          marker === null
            ? Effect.fail(new RestorePendingError({ worktreePath }))
            : fs
                .writeFileString(marker, JSON.stringify(state))
                .pipe(Effect.mapError((cause) => new RestorePendingError({ worktreePath, cause }))),
        ),
      ),
    clear: (worktreePath: string) =>
      markerPath(worktreePath).pipe(
        Effect.flatMap((marker) =>
          marker === null ? Effect.void : fs.remove(marker, { force: true }),
        ),
      ),
  };
});
