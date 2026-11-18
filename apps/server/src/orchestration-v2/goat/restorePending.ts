// @effect-diagnostics nodeBuiltinImport:off -- Workspace paths are hashed into private recovery filenames.
import * as NodeCrypto from "node:crypto";
import { normalizeProjectPathForComparison } from "@goat/shared/path";
import { ServerConfig } from "../../config.ts";
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
  /** Set once the snapshot is in the folder; before that a resumed restore must start over. */
  applied: Schema.optionalKey(Schema.Boolean),
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

const jsonState = Schema.fromJsonString(RestorePendingState);
const decode = Schema.decodeUnknownEffect(jsonState);
const encode = Schema.encodeEffect(jsonState);

/** Records recovery before Git can register the checkout. Older linked markers remain readable. */
export const makeRestorePending = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const directory = path.join(config.stateDir, "worktree-restore-pending");
  const sidecar = (worktreePath: string) =>
    path.join(
      directory,
      NodeCrypto.createHash("sha256")
        .update(normalizeProjectPathForComparison(path.resolve(worktreePath)))
        .digest("hex") + ".json",
    );
  const legacyMarker = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((pointer) =>
        pointer.startsWith("gitdir:")
          ? path.join(path.resolve(worktreePath, pointer.slice(7).trim()), MARKER)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );
  const markerPath = Effect.fn("RestorePending.markerPath")(function* (worktreePath: string) {
    const marker = sidecar(worktreePath);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return marker;
    if (!(yield* fs.exists(path.join(worktreePath, ".git")).pipe(Effect.orElseSucceed(() => true))))
      return null;
    return yield* legacyMarker(worktreePath);
  });
  const marked = Effect.fn("RestorePending.marked")(function* (worktreePath: string) {
    const marker = yield* markerPath(worktreePath);
    return marker !== null && (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true)));
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
    write: Effect.fn("RestorePending.write")(
      function* (worktreePath: string, state: RestorePendingState) {
        yield* fs.makeDirectory(directory, { recursive: true });
        const draft = yield* fs.makeTempFileScoped({ directory, prefix: ".goat-restore-" });
        yield* fs.writeFileString(draft, yield* encode(state));
        yield* fs.rename(draft, sidecar(worktreePath));
      },
      (effect, worktreePath) =>
        effect.pipe(
          Effect.scoped,
          Effect.mapError((cause) => new RestorePendingError({ worktreePath, cause })),
        ),
    ),
    clear: Effect.fn("RestorePending.clear")(function* (worktreePath: string) {
      const old = yield* legacyMarker(worktreePath);
      if (old !== null) yield* fs.remove(old, { force: true });
      yield* fs.remove(sidecar(worktreePath), { force: true });
    }),
  };
});
