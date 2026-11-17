import type { StorageItem, StorageItemState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { WORKTREE_BUSY_STATUSES } from "../mcp/WorktreeInventoryService.ts";
import type { ContentStamp, FileIdentity } from "./fileState.ts";
import { lstatOf } from "./fileState.ts";
import { isStrictlyInside, type PathRules, samePath } from "./storagePaths.ts";

/**
 * No project ("Scratch") threads each work in a folder of <GOAT home>/scratch. Storage lists those
 * folders for a person to delete one by one; nothing removes them on its own, and the thread's
 * next turn or terminal starts in an empty folder in its place.
 *
 * @module scratchFolders
 */

/** Leftover and scratch folders younger than this may still be in use. */
const SCRATCH_MIN_AGE_MS = 60 * 60_000;

interface ScratchThreadRow {
  readonly id: string;
  readonly title: string | null;
  readonly path: string;
  readonly status: string | null;
  readonly activeRunId: string | null;
  readonly pendingRequest: string | null;
  readonly pendingTasks: number | null;
  readonly updatedAt: string | null;
}

/** A run, a queued or waiting turn, a question or background work: the folder is in use. */
const busy = (row: ScratchThreadRow) =>
  row.activeRunId !== null ||
  (row.status !== null && WORKTREE_BUSY_STATUSES.has(row.status)) ||
  row.pendingRequest !== null ||
  (row.pendingTasks ?? 0) > 0;

/** This server's threads that are not deleted and work in a folder or inside it; null if unread. */
const scratchThreadsUsing = Effect.fn("scratchFolders.threadsUsing")(function* (
  folder: string,
  rules: PathRules,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rows = yield* sql<ScratchThreadRow>`
    SELECT thread_id AS "id",
      COALESCE(json_extract(payload_json, '$.title'), title) AS "title",
      json_extract(payload_json, '$.worktreePath') AS "path",
      json_extract(payload_json, '$.status') AS "status",
      json_extract(payload_json, '$.activeRunId') AS "activeRunId",
      json_extract(payload_json, '$.pendingRuntimeRequest') AS "pendingRequest",
      json_array_length(payload_json, '$.pendingBackgroundTasks') AS "pendingTasks",
      updated_at AS "updatedAt"
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
  `.pipe(Effect.orElseSucceed(() => null));
  if (rows === null) return null;
  const real = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const targets = [path.resolve(folder), yield* real(folder)];
  const users: Array<ScratchThreadRow & { readonly busy: boolean }> = [];
  for (const row of rows) {
    const bound = [path.resolve(row.path), yield* real(row.path)];
    if (
      targets.some((target) =>
        bound.some(
          (value) => samePath(value, target, rules) || isStrictlyInside(target, value, rules),
        ),
      )
    )
      users.push({ ...row, busy: busy(row) });
  }
  return users.toSorted((left, right) => left.id.localeCompare(right.id));
});

/** Why a reviewed scratch folder must stay now: its threads changed or one started working. */
export const scratchReuseReason = Effect.fn("scratchFolders.reuseReason")(function* (
  folder: string,
  reviewed: ReadonlyArray<string>,
  rules: PathRules,
) {
  const users = yield* scratchThreadsUsing(folder, rules);
  if (users === null) return "this server's threads could not be read";
  const working = users.find((user) => user.busy);
  if (working !== undefined) return "its thread is working in it now";
  if (users.map((user) => user.id).join("\n") !== reviewed.join("\n"))
    return "a thread started using it after it was reviewed";
  return null;
});

type Decision = {
  readonly state: StorageItemState;
  readonly reason: string;
  readonly selected: boolean;
};

/** Adds each folder of the scratch root, never pre-selected, to the scan. */
export const scanScratchFolders = Effect.fn("scratchFolders.scan")(function* (scan: {
  readonly baseDir: string;
  readonly rules: PathRules;
  readonly notes: Array<string>;
  readonly state: (value: StorageItemState, reason: string) => Decision;
  /** Other GOAT servers or running processes that use a folder; null when none. */
  readonly usedOutside: (target: string) => Decision | null;
  readonly stamped: (
    id: string,
    folder: string,
    minAgeMs: number,
    decision: Decision,
  ) => Effect.Effect<{
    readonly decision: Decision;
    readonly token: ReadonlyArray<string | number | bigint>;
    readonly stamp: ContentStamp | null;
  }>;
  readonly add: (
    item: Omit<StorageItem, "id" | "token" | "bytes">,
    target: {
      readonly kind: "path";
      readonly root: string;
      readonly identity: FileIdentity;
      readonly worktree: null;
      readonly stamp: ContentStamp | null;
      readonly scratchThreads: ReadonlyArray<string>;
    },
    identity: ReadonlyArray<string | number | bigint | null>,
  ) => void;
  readonly measureLater: (id: string, target: string, priority: number) => void;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .realPath(path.join(scan.baseDir, "scratch"))
    .pipe(Effect.orElseSucceed(() => null));
  if (root === null) return;
  for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    const folder = path.join(root, name);
    const stat = yield* lstatOf(folder);
    if (stat === null || !stat.isDirectory || stat.isLink) continue;
    const users = yield* scratchThreadsUsing(folder, scan.rules);
    if (users === null) {
      scan.notes.push(
        "This server's threads could not be read, so no No project folder is offered.",
      );
      return;
    }
    const working = users.find((user) => user.busy);
    const named = users[0];
    const offered =
      scan.usedOutside(folder) ??
      (working !== undefined
        ? scan.state(
            "protected",
            `The No project thread "${working.title ?? working.id}" is working in it`,
          )
        : scan.state(
            "removable",
            (named === undefined
              ? "No thread uses this No project folder."
              : `Folder of the No project thread "${named.title ?? named.id}"${
                  named.updatedAt === null ? "" : `, idle since ${named.updatedAt.slice(0, 10)}`
                }.`) +
              " Removing it deletes its files for good" +
              (named === undefined ? "." : "; the thread's next turn starts in an empty folder."),
          ));
    const id = "orphan_folder:" + folder;
    const { decision, token, stamp } = yield* scan.stamped(id, folder, SCRATCH_MIN_AGE_MS, offered);
    const threads = users.map((user) => user.id);
    scan.add(
      { kind: "orphan_folder", path: folder, label: path.join("No project", name), ...decision },
      {
        kind: "path",
        root,
        identity: stat.identity,
        worktree: null,
        stamp,
        scratchThreads: threads,
      },
      [stat.identity.dev, stat.identity.ino, ...token, ...threads],
    );
    scan.measureLater(id, folder, decision.state === "removable" ? 1 : 3);
  }
});
