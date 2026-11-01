import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ThreadHistoryArchive } from "../orchestration-v2/ThreadHistoryArchive.ts";
import { lstatOf, type FileIdentity } from "./fileState.ts";
import { survivorMentions } from "./survivorMentions.ts";

/** Files younger than this may belong to a deletion GOAT is still finishing. */
const ATTACHMENT_MIN_AGE_MS = 24 * 60 * 60_000;
/** Deleted thread groups considered in one survivor scan. */
const THREADS_CHECKED_PER_SCAN = 40;
/** Archived history read per scan; beyond it no deleted thread's files are offered. */
const ARCHIVE_BYTES_READ_PER_SCAN = 512 * 1024 * 1024;

export interface AttachmentFile {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly size: number;
}

/**
 * Files deleted threads left in this server's attachments folder, split into those nothing
 * surviving refers to and those kept: still mentioned, too recent, or not checked this scan.
 */
export const deletedThreadAttachments = Effect.fn("storage.deletedThreadAttachments")(
  function* (input: {
    readonly attachmentsDir: string;
    readonly threads: ReadonlyArray<{ readonly id: string; readonly deleted: string | null }>;
    readonly now: number;
    /** Look only at these files, as when cleanup checks its selection again. */
    readonly only?: ReadonlySet<string>;
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
      if (input.only !== undefined && !input.only.has(file)) continue;
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
    const databaseMentions =
      archived === null || largestFirst.length === 0
        ? null
        : yield* survivorMentions(
            largestFirst
              .slice(0, THREADS_CHECKED_PER_SCAN)
              .flatMap(([segment]) => [...needlesOf(segment)]),
          );
    const unmentioned: Array<ReadonlyArray<AttachmentFile>> = [];
    for (const [index, [segment, files]] of largestFirst.entries()) {
      let mentioned: boolean | null =
        index >= THREADS_CHECKED_PER_SCAN || archived === null
          ? null
          : [...needlesOf(segment)].some((needle) => archived.has(needle));
      if (mentioned === false) {
        mentioned =
          databaseMentions === null
            ? null
            : [...needlesOf(segment)].some((needle) => databaseMentions.has(needle));
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
