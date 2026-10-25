// @effect-diagnostics nodeBuiltinImport:off - a short read-only query against another server's WAL database.
import * as NodeSqlite from "node:sqlite";

import { LEGACY_HOME_DIR_NAME } from "@goat/contracts/legacyT3Names";
import { CHANNEL_STATE_COPY_MARKER_FILE_NAME } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The GOAT homes other servers on this machine use by default: a headless server, the desktop app
 * and the nightly desktop app (whose state starts as a copy of the desktop app's, so both bind the
 * same worktrees), the legacy home, and an explicit GOAT_HOME. PR #1632 replaces this list with
 * discovery of running servers; until then storage cleanup reads these.
 */
const localGoatHomes = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const goat = path.join(home, GOAT_HOME_DIR_NAME);
  return [
    ...new Set(
      [
        env.GOAT_HOME?.trim() ?? "",
        goat,
        path.join(goat, "desktop"),
        path.join(goat, "desktop-nightly"),
        path.join(home, LEGACY_HOME_DIR_NAME),
      ]
        .filter((value) => value !== "")
        .map((value) => path.resolve(value)),
    ),
  ];
});

const inside = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Drops worktree roots that belong to another GOAT home: a root inside another home and not inside
 * this server's own base directory. A nightly copy keeps stable's settings, so a worktree folder
 * configured there would otherwise make the nightly clean stable's worktrees.
 * A home seeded as a copy keeps only roots inside itself, since any folder its copied settings name
 * may hold stable's worktrees.
 */
export const ownWorktreeRoots = Effect.fnUntraced(function* (input: {
  readonly roots: ReadonlyArray<string>;
  readonly baseDir: string;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const real = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const ownBase = yield* real(input.baseDir);
  // A marker that cannot be checked counts as present: the narrower roots are the safe side.
  const copied = yield* fs
    .exists(path.join(ownBase, CHANNEL_STATE_COPY_MARKER_FILE_NAME))
    .pipe(Effect.orElseSucceed(() => true));
  if (copied) {
    return input.roots.filter((root) => inside(path, ownBase, root));
  }
  const others = yield* Effect.forEach(yield* localGoatHomes(), real);
  return input.roots.filter(
    (root) =>
      inside(path, ownBase, root) ||
      !others.some((other) => other !== ownBase && inside(path, other, root)),
  );
});

export interface OtherHomeBindings {
  /** Every worktree path another home's threads record, whatever the thread's state. */
  readonly worktreePaths: ReadonlySet<string>;
  /** Databases that exist but could not be read; cleanup must then keep every worktree. */
  readonly unreadable: ReadonlyArray<string>;
}

// Another server writes this database in WAL mode, which lets a read-only reader in without
// blocking it; a read-only connection never checkpoints into it.
const readWorktreePaths = (file: string) =>
  Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 });
      try {
        return db
          .prepare(
            "SELECT json_extract(payload_json, '$.worktreePath') AS path FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL",
          )
          .all()
          .flatMap((row) => (typeof row.path === "string" ? [row.path] : []));
      } finally {
        db.close();
      }
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

/** What the other local GOAT homes' databases bind, so cleanup never removes their checkouts. */
export const readOtherHomeBindings = Effect.fn("otherGoatHomes.readOtherHomeBindings")(
  function* (input: { readonly ownDatabase: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = (value: string) =>
      fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
    const own = yield* real(input.ownDatabase);
    const worktreePaths = new Set<string>();
    const unreadable: Array<string> = [];
    const seen = new Set<string>([own]);
    for (const home of yield* localGoatHomes()) {
      for (const state of ["userdata", "dev"]) {
        const candidate = path.join(home, state, "statev2.sqlite");
        // Only a confirmed absence is skipped; a home that cannot be checked holds every worktree.
        const present = yield* fs.exists(candidate).pipe(Effect.result);
        if (present._tag === "Failure") {
          unreadable.push(candidate);
          continue;
        }
        if (!present.success) continue;
        const file = yield* real(candidate);
        if (seen.has(file)) continue;
        seen.add(file);
        const rows = yield* readWorktreePaths(file).pipe(Effect.result);
        if (rows._tag === "Failure") {
          unreadable.push(file);
          continue;
        }
        for (const worktreePath of rows.success) worktreePaths.add(yield* real(worktreePath));
      }
    }
    return { worktreePaths, unreadable } satisfies OtherHomeBindings;
  },
);
