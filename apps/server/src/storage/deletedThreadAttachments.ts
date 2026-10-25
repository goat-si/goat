import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ThreadHistoryArchive } from "../orchestration-v2/ThreadHistoryArchive.ts";
import { lstatOf, type FileIdentity } from "./fileState.ts";

/** Files younger than this may belong to a deletion GOAT is still finishing. */
const ATTACHMENT_MIN_AGE_MS = 24 * 60 * 60_000;
/** Deleted threads checked per scan; each check reads the thread tables once. */
const THREADS_CHECKED_PER_SCAN = 40;
/** Archived history read per scan; beyond it no deleted thread's files are offered. */
const ARCHIVE_BYTES_READ_PER_SCAN = 512 * 1024 * 1024;

export interface AttachmentFile {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly size: number;
}

/**
 * Whether anything that survives still mentions a deleted thread: a thread forked from it or
 * handed its context, a message or tool result quoting one of its files, unfinished work or a
 * scheduled prompt. A thread's attachment ids start with its id, so any copy of one of its files'
 * ids mentions it too. Archived threads whose history moved out of the database still name their
 * source in their own record; their archived tool history is read separately. Null when the
 * tables cannot be read.
 */
const mentionedBySurvivors = Effect.fn("storage.mentionedBySurvivors")(function* (needle: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly one: number }>`
    SELECT 1 AS "one" WHERE
      EXISTS (SELECT 1 FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND instr(payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS item
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
        WHERE thread.deleted_at IS NULL AND instr(item.payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
        WHERE thread.deleted_at IS NULL AND instr(item.payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id = ${needle} OR target_thread_id = ${needle}
          OR instr(payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_context_handoffs
        WHERE instr(payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox
        WHERE status IN ('pending', 'running') AND instr(payload_json, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM mcp_app_model_context WHERE instr(text, ${needle}) > 0)
      OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE instr(prompt, ${needle}) > 0)
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => rows.length > 0),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Files deleted threads left in this server's attachments folder, split into those nothing
 * surviving refers to and those kept: still mentioned, too recent, or not checked this scan.
 */
export const deletedThreadAttachments = Effect.fn("storage.deletedThreadAttachments")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly threads: ReadonlyArray<{ readonly id: string; readonly deleted: string | null }>;
    readonly now: number;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const live = new Set<string>();
    const deleted = new Map<string, Array<string>>();
    for (const thread of input.threads) {
      const segment = toSafeThreadAttachmentSegment(thread.id);
      if (segment === null) continue;
      if (thread.deleted === null) live.add(segment);
      else deleted.set(segment, [...(deleted.get(segment) ?? []), thread.id]);
    }
    const bySegment = new Map<string, Array<AttachmentFile>>();
    const kept = { count: 0, bytes: 0 };
    for (const name of yield* fs
      .readDirectory(input.attachmentsDir)
      .pipe(Effect.orElseSucceed(() => []))) {
      const segment = parseThreadSegmentFromAttachmentId(
        name.slice(0, name.length - path.extname(name).length),
      );
      // A segment shared with a surviving thread (ids can truncate alike) is that thread's too.
      if (segment === null || live.has(segment) || !deleted.has(segment)) continue;
      const file = path.join(input.attachmentsDir, name);
      const stat = yield* lstatOf(file);
      if (stat === null || !stat.isFile || stat.isLink) continue;
      if (input.now - stat.mtimeMs < ATTACHMENT_MIN_AGE_MS) {
        kept.count += 1;
        kept.bytes += stat.size;
        continue;
      }
      bySegment.set(segment, [
        ...(bySegment.get(segment) ?? []),
        { path: file, identity: stat.identity, size: stat.size },
      ]);
    }
    const removable: Array<AttachmentFile> = [];
    const largestFirst = [...bySegment].toSorted(
      ([, left], [, right]) =>
        right.reduce((sum, file) => sum + file.size, 0) -
        left.reduce((sum, file) => sum + file.size, 0),
    );
    const needlesOf = (segment: string) => new Set([segment, ...(deleted.get(segment) ?? [])]);
    const archives = yield* ThreadHistoryArchive;
    // Archiving moves history out of the database: one that lands between reading the archives
    // and reading the database hides a reference from both, so the archives must not change.
    const before = largestFirst.length === 0 ? "" : yield* archives.snapshotKey;
    // Archived history of surviving threads, read once for every thread checked this scan.
    const archived =
      largestFirst.length === 0 || before === null
        ? largestFirst.length === 0
          ? new Set<string>()
          : null
        : yield* archives.mentions(
            largestFirst
              .slice(0, THREADS_CHECKED_PER_SCAN)
              .flatMap(([segment]) => [...needlesOf(segment)]),
            ARCHIVE_BYTES_READ_PER_SCAN,
          );
    const unmentioned: Array<ReadonlyArray<AttachmentFile>> = [];
    for (const [index, [segment, files]] of largestFirst.entries()) {
      let mentioned: boolean | null =
        index >= THREADS_CHECKED_PER_SCAN || archived === null
          ? null
          : [...needlesOf(segment)].some((needle) => archived.has(needle));
      for (const needle of needlesOf(segment)) {
        if (mentioned !== false) break;
        mentioned = yield* mentionedBySurvivors(needle);
      }
      if (mentioned === false) unmentioned.push(files);
      else {
        kept.count += files.length;
        kept.bytes += files.reduce((sum, file) => sum + file.size, 0);
      }
    }
    const stable = largestFirst.length === 0 || (yield* archives.snapshotKey) === before;
    for (const files of unmentioned) {
      if (stable) removable.push(...files);
      else {
        kept.count += files.length;
        kept.bytes += files.reduce((sum, file) => sum + file.size, 0);
      }
    }
    return { removable, kept };
  },
);
