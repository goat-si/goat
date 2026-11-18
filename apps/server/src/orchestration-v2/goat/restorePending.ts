import { canonicalizeWorkspacePath } from "../../workspace/canonicalizeWorkspacePath.ts";
import { git } from "./restoreSnapshot.ts";
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
  const markerName = (worktreePath: string) =>
    NodeCrypto.createHash("sha256")
      .update(normalizeProjectPathForComparison(worktreePath))
      .digest("hex") + ".json";
  const sidecar = (worktreePath: string) =>
    path.join(config.stateDir, "worktree-restore-pending", markerName(path.resolve(worktreePath)));
  const registration = (worktreePath: string) =>
    fs.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((pointer) =>
        pointer.startsWith("gitdir:") ? path.resolve(worktreePath, pointer.slice(7).trim()) : null,
      ),
      Effect.orElseSucceed(() => null),
    );
  const legacyMarker = (worktreePath: string) =>
    registration(worktreePath).pipe(
      Effect.map((dir) => (dir === null ? null : path.join(dir, MARKER))),
    );
  const commonDirectory = Effect.fn("RestorePending.commonDirectory")(function* (
    worktreePath: string,
    projectCwd?: string,
  ) {
    if (projectCwd !== undefined) {
      const standard = path.join(projectCwd, ".git");
      const directory = yield* fs.stat(standard).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (directory) return standard;
      return yield* Effect.tryPromise(async () =>
        path.resolve(
          projectCwd,
          (await git(projectCwd, ["rev-parse", "--git-common-dir"])).toString().trim(),
        ),
      );
    }
    const admin = yield* registration(worktreePath);
    if (admin === null) return null;
    return yield* fs.readFileString(path.join(admin, "commondir")).pipe(
      Effect.map((name) => path.resolve(admin, name.trim())),
      Effect.orElseSucceed(() => null),
    );
  });
  const sharedMarker = Effect.fn("RestorePending.sharedMarker")(function* (
    worktreePath: string,
    projectCwd?: string,
  ) {
    const common = yield* commonDirectory(worktreePath, projectCwd);
    if (common === null) return null;
    const canonical = yield* canonicalizeWorkspacePath(fs, path, path.resolve(worktreePath));
    return path.join(common, "goat-restore-pending", markerName(canonical));
  });
  const markerPath = Effect.fn("RestorePending.markerPath")(function* (
    worktreePath: string,
    projectCwd?: string,
  ) {
    const linked = yield* fs
      .exists(path.join(worktreePath, ".git"))
      .pipe(Effect.orElseSucceed(() => true));
    if (linked || projectCwd !== undefined) {
      const shared = yield* sharedMarker(worktreePath, projectCwd).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (shared !== null && (yield* fs.exists(shared).pipe(Effect.orElseSucceed(() => true))))
        return shared;
    }
    const marker = sidecar(worktreePath);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return marker;
    return linked ? yield* legacyMarker(worktreePath) : null;
  });
  const marked = Effect.fn("RestorePending.marked")(function* (
    worktreePath: string,
    projectCwd?: string,
  ) {
    const marker = yield* markerPath(worktreePath, projectCwd);
    return marker !== null && (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true)));
  });
  return {
    marked,
    /** Present and not waiting on an unfinished restore; an unreadable folder counts as present. */
    ready: Effect.fn("RestorePending.ready")(function* (worktreePath: string, projectCwd?: string) {
      if (!(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true)))) return false;
      return !(yield* marked(worktreePath, projectCwd));
    }),
    read: (worktreePath: string, projectCwd?: string) =>
      markerPath(worktreePath, projectCwd).pipe(
        Effect.flatMap((marker) =>
          marker === null ? Effect.succeed(null) : fs.readFileString(marker),
        ),
        Effect.flatMap((json) => (json === null ? Effect.succeed(null) : decode(json))),
        Effect.orElseSucceed(() => null),
      ),
    write: Effect.fn("RestorePending.write")(
      function* (worktreePath: string, state: RestorePendingState, projectCwd?: string) {
        const marker =
          (yield* sharedMarker(worktreePath, projectCwd)) ?? (yield* legacyMarker(worktreePath));
        if (marker === null) return yield* new RestorePendingError({ worktreePath });
        const directory = path.dirname(marker);
        yield* fs.makeDirectory(directory, { recursive: true });
        const draft = yield* fs.makeTempFileScoped({ directory, prefix: ".goat-restore-" });
        yield* fs.writeFileString(draft, yield* encode(state));
        yield* fs.rename(draft, marker);
      },
      (effect, worktreePath) =>
        effect.pipe(
          Effect.scoped,
          Effect.mapError((cause) => new RestorePendingError({ worktreePath, cause })),
        ),
    ),
    clear: Effect.fn("RestorePending.clear")(function* (worktreePath: string, projectCwd?: string) {
      const shared = yield* sharedMarker(worktreePath, projectCwd);
      if (shared !== null) yield* fs.remove(shared, { force: true });
      const old = yield* legacyMarker(worktreePath);
      if (old !== null) yield* fs.remove(old, { force: true });
      yield* fs.remove(sidecar(worktreePath), { force: true });
    }),
  };
});
