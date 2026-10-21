// @effect-diagnostics nodeBuiltinImport:off - zstd frames, SHA-256 and directory fsync have no Effect API.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import { ThreadArchiveGate } from "./ThreadArchiveGate.ts";

/** Raw bytes per zstd frame: large enough to compress like one stream, small enough to stall ~2 ms. */
const FRAME_RAW_BYTES = 1_048_576;
/** Rows one key window holds; rows are then read one statement at a time. */
const PAGE_ROWS = 16;
/** One delete frees at most this many rows or bytes: each row updates about ten indexes. */
const DELETE_ROWS = 4;
const DELETE_BYTES = 262_144;
const ZSTD_LEVEL = 3;
/** Rows one restore transaction inserts, bounded by count and payload size. */
const RESTORE_ROWS = 32;
const RESTORE_BYTES = 262_144;
/** A restore that failed is retried no sooner than this, so reads do not hammer a bad file. */
const RESTORE_RETRY_MS = 60_000;

const TURN_ITEMS = "orchestration_v2_projection_turn_items";
const EVENTS = "orchestration_events";

export class ThreadHistoryArchiveError extends Schema.TaggedError<ThreadHistoryArchiveError>()(
  "ThreadHistoryArchiveError",
  {
    operation: Schema.String,
    threadId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Thread history archive ${this.operation} failed${this.threadId ? ` for ${this.threadId}` : ""}.`;
  }
}

export interface ThreadHistoryArchivePolicy {
  readonly archiveAfterDays: number | null;
  readonly deleteAfterDays: number | null;
  readonly now: number;
}

export interface ThreadHistoryArchivePass {
  readonly archivedThreads: number;
  /** Database payload bytes moved out. Pages return to the freelist. */
  readonly archivedRawBytes: number;
  readonly archiveFileBytes: number;
  readonly deletedArchives: number;
}

/** Where a thread's tool history now lives; null when it is back in the database. */
export interface ThreadHistoryArchiveChange {
  readonly threadId: string;
  readonly state: "archived" | "deleted" | null;
}

export interface ThreadHistoryArchiveStats {
  readonly threads: number;
  readonly fileBytes: number;
}

export class ThreadHistoryArchive extends Context.Service<
  ThreadHistoryArchive,
  {
    /**
     * Finishes interrupted work, archives threads idle past the policy, oldest first, and
     * applies the hard-delete policy. Works in small pages and yields between them.
     */
    readonly runPass: (
      policy: ThreadHistoryArchivePolicy,
    ) => Effect.Effect<ThreadHistoryArchivePass, ThreadHistoryArchiveError>;
    /** Copies an archived thread's turn items back. True when something was restored. */
    readonly restore: (threadId: string) => Effect.Effect<boolean, ThreadHistoryArchiveError>;
    readonly stats: Effect.Effect<ThreadHistoryArchiveStats, ThreadHistoryArchiveError>;
    /** Every archive, restore and hard delete, as it commits. */
    readonly changes: Stream.Stream<ThreadHistoryArchiveChange>;
  }
>()("goat/orchestration-v2/ThreadHistoryArchive") {}

const encodeLine = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      t: Schema.Literals(["item", "event"]),
      r: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      t: Schema.Literals(["item", "event"]),
      r: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const decodeFrames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)));
const encodeFrames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)));

type ArchiveRow = {
  readonly thread_id: string;
  readonly state: "archived" | "restoring" | "deleted";
  readonly archived_at: string;
  readonly file_name: string;
  readonly sha256: string;
  readonly frames_json: string;
  readonly item_count: number;
  readonly event_count: number;
  readonly rows_deleted: number;
};

type ItemKey = { readonly id: string; readonly updatedAt: string };

/**
 * Work or questions in these states still have someone waiting on them, so their thread stays
 * whole. Other item types can stay `running` on finished threads (a todo list does), so the
 * status alone does not count.
 */
const LIVE_ITEM_STATUSES = new Set(["pending", "running", "waiting"]);
const LIVE_ITEM_TYPES = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
  "human_handoff",
  "secret_request",
  "user_input_request",
  "approval_request",
]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const gate = yield* ThreadArchiveGate;
  const directory = path.join(path.dirname(config.dbPath), "thread-archive");
  // Archiving and restoring the same thread must not interleave; both are rare and short.
  const lock = yield* Semaphore.make(1);
  const fail = (operation: string, threadId?: string) => (cause: unknown) =>
    new ThreadHistoryArchiveError({
      operation,
      ...(threadId === undefined ? {} : { threadId }),
      cause,
    });

  const columnsOf = (table: string) =>
    sql
      .unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`)
      .pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));
  const columns = {
    item: yield* columnsOf(TURN_ITEMS).pipe(Effect.orDie),
    event: yield* columnsOf(EVENTS).pipe(Effect.orDie),
  };

  // Threads with archived or restoring rows. Reads of any other thread skip the gate for free.
  const pending = new Set(
    (yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_thread_history_archives WHERE state IN ('archived', 'restoring')
    `.pipe(Effect.orElseSucceed(() => []))).map((row) => row.thread_id),
  );
  const restoreFailedUntil = new Map<string, number>();
  const changes = yield* PubSub.unbounded<ThreadHistoryArchiveChange>();
  const announce = (threadId: string, state: ThreadHistoryArchiveChange["state"]) =>
    PubSub.publish(changes, { threadId, state });

  const fileNameFor = (threadId: string) =>
    `${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32)}.jsonl.zst`;

  const readArchiveRow = (threadId: string) =>
    sql<ArchiveRow>`
      SELECT thread_id, state, archived_at, file_name, sha256, frames_json, item_count, event_count, rows_deleted
      FROM orchestration_v2_thread_history_archives WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]));

  const itemKeys = Effect.fn("ThreadHistoryArchive.itemKeys")(function* (threadId: string) {
    const keys: ItemKey[] = [];
    let afterOrdinal = Number.MIN_SAFE_INTEGER;
    let afterId = "";
    while (true) {
      const page = yield* sql<{
        readonly turn_item_id: string;
        readonly ordinal: number;
        readonly updated_at: string;
        readonly status: string;
        readonly type: string;
      }>`
        SELECT turn_item_id, ordinal, updated_at, status, type FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND (ordinal, turn_item_id) > (${afterOrdinal}, ${afterId})
        ORDER BY ordinal, turn_item_id LIMIT ${PAGE_ROWS}
      `;
      for (const row of page) {
        if (LIVE_ITEM_STATUSES.has(row.status) && LIVE_ITEM_TYPES.has(row.type)) return undefined;
        keys.push({ id: row.turn_item_id, updatedAt: row.updated_at });
      }
      yield* Effect.yieldNow;
      if (page.length < PAGE_ROWS) return keys;
      afterOrdinal = page.at(-1)!.ordinal;
      afterId = page.at(-1)!.turn_item_id;
    }
  });

  const eventKeys = Effect.fn("ThreadHistoryArchive.eventKeys")(function* (threadId: string) {
    const keys: number[] = [];
    let after = 0;
    while (true) {
      const page = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND stream_id = ${threadId} AND sequence > ${after}
        ORDER BY sequence LIMIT ${PAGE_ROWS}
      `;
      if (page.length === 0) return keys;
      const matching = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE sequence IN ${sql.in(page.map((row) => row.sequence))} AND event_type = 'turn-item.updated'
      `;
      for (const row of matching) keys.push(row.sequence);
      yield* Effect.yieldNow;
      if (page.length < PAGE_ROWS) return keys;
      after = page.at(-1)!.sequence;
    }
  });

  // Deletes in groups bounded by rows and bytes, yielding between groups. Untraced: it runs
  // per group inside deleteArchivedRows, which already spans the work.
  const deleteBounded = Effect.fnUntraced(function* <K>(
    keys: ReadonlyArray<K>,
    sizeOf: (key: K) => Effect.Effect<number, SqlError>,
    remove: (keys: ReadonlyArray<K>) => Effect.Effect<unknown, SqlError>,
  ) {
    let batch: K[] = [];
    let bytes = 0;
    for (const key of keys) {
      batch.push(key);
      bytes += yield* sizeOf(key);
      if (batch.length < DELETE_ROWS && bytes < DELETE_BYTES) continue;
      yield* remove(batch);
      batch = [];
      bytes = 0;
      yield* Effect.yieldNow;
    }
    if (batch.length > 0) {
      yield* remove(batch);
      yield* Effect.yieldNow;
    }
  });

  // Deletes exactly the archived versions: an item updated after archiving keeps its newer row.
  const deleteArchivedRows = Effect.fn("ThreadHistoryArchive.deleteArchivedRows")(function* (
    threadId: string,
    items: ReadonlyArray<ItemKey>,
    events: ReadonlyArray<number>,
  ) {
    yield* deleteBounded(
      events,
      (sequence) =>
        sql<{
          readonly bytes: number | null;
        }>`SELECT octet_length(payload_json) AS bytes FROM orchestration_events WHERE sequence = ${sequence}`.pipe(
          Effect.map((rows) => rows[0]?.bytes ?? 0),
        ),
      (sequences) =>
        sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(sequences)} AND event_type = 'turn-item.updated'`,
    );
    yield* deleteBounded(
      items,
      (key) =>
        sql<{
          readonly bytes: number | null;
        }>`SELECT octet_length(payload_json) AS bytes FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${key.id}`.pipe(
          Effect.map((rows) => rows[0]?.bytes ?? 0),
        ),
      (keys) =>
        Effect.forEach(
          keys,
          (key) =>
            sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${key.id} AND thread_id = ${threadId} AND updated_at = ${key.updatedAt}`,
          { discard: true },
        ),
    );
    yield* sql`UPDATE orchestration_v2_thread_history_archives SET rows_deleted = 1 WHERE thread_id = ${threadId}`;
  });

  const fsyncDirectory = Effect.sync(() => {
    const fd = NodeFS.openSync(directory, "r");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
  });

  // Every line, frame by frame, with a yield between frames.
  const readArchive = Effect.fn("ThreadHistoryArchive.readArchive")(function* (
    row: ArchiveRow,
    visitFrame: (lines: ReadonlyArray<string>) => Effect.Effect<void, SqlError>,
  ) {
    const bytes = yield* fs.readFile(path.join(directory, row.file_name));
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== row.sha256)
      return yield* new ThreadHistoryArchiveError({
        operation: "verify",
        threadId: row.thread_id,
        cause: "checksum mismatch",
      });
    let offset = 0;
    let lines = 0;
    for (const length of decodeFrames(row.frames_json)) {
      const text = NodeZlib.zstdDecompressSync(bytes.subarray(offset, offset + length)).toString(
        "utf8",
      );
      offset += length;
      // Lines stay text here; visitors decode what they use, a group at a time.
      const decoded = text.split("\n").filter((line) => line !== "");
      yield* visitFrame(decoded);
      lines += decoded.length;
      yield* Effect.yieldNow;
    }
    if (lines !== row.item_count + row.event_count)
      return yield* new ThreadHistoryArchiveError({
        operation: "verify",
        threadId: row.thread_id,
        cause: "row count mismatch",
      });
  });

  const archiveThread = Effect.fn("ThreadHistoryArchive.archiveThread")(function* (
    threadId: string,
    now: number,
  ) {
    const existing = yield* readArchiveRow(threadId);
    if (existing !== undefined) return undefined;
    const items = yield* itemKeys(threadId);
    if (items === undefined) return undefined;
    const events = yield* eventKeys(threadId);
    if (items.length === 0 && events.length === 0) return undefined;
    const fileName = fileNameFor(threadId);
    const finalPath = path.join(directory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    const hash = NodeCrypto.createHash("sha256");
    const frames: number[] = [];
    let rawBytes = 0;
    let fileBytes = 0;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporaryPath, { flag: "w" });
        let buffer: string[] = [];
        let bufferBytes = 0;
        const flush = Effect.gen(function* () {
          if (buffer.length === 0) return;
          const frame = NodeZlib.zstdCompressSync(Buffer.from(buffer.join("")), {
            params: { [NodeZlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
          });
          yield* file.writeAll(frame);
          hash.update(frame);
          frames.push(frame.length);
          fileBytes += frame.length;
          buffer = [];
          bufferBytes = 0;
          yield* Effect.yieldNow;
        });
        // Untraced: it runs once per archived row.
        const append = Effect.fnUntraced(function* (line: string) {
          buffer.push(line, "\n");
          bufferBytes += Buffer.byteLength(line, "utf8") + 1;
          rawBytes += Buffer.byteLength(line, "utf8") + 1;
          if (bufferBytes >= FRAME_RAW_BYTES) yield* flush;
        });
        for (const key of items) {
          const [row] = yield* sql<
            Record<string, unknown>
          >`SELECT * FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${key.id}`;
          if (row !== undefined) yield* append(encodeLine({ t: "item", r: row }));
          yield* Effect.yieldNow;
        }
        for (const sequence of events) {
          const [row] = yield* sql<
            Record<string, unknown>
          >`SELECT * FROM orchestration_events WHERE sequence = ${sequence}`;
          if (row !== undefined) yield* append(encodeLine({ t: "event", r: row }));
          yield* Effect.yieldNow;
        }
        yield* flush;
        yield* file.sync;
      }),
    );
    yield* fs.rename(temporaryPath, finalPath);
    yield* fsyncDirectory;
    const row: ArchiveRow = {
      thread_id: threadId,
      state: "archived",
      archived_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
      file_name: fileName,
      sha256: hash.digest("hex"),
      frames_json: encodeFrames(frames),
      item_count: items.length,
      event_count: events.length,
      rows_deleted: 0,
    };
    // Verify what is on disk before any row leaves the database.
    yield* readArchive(row, () => Effect.void);
    yield* sql`
      INSERT INTO orchestration_v2_thread_history_archives
        (thread_id, state, archived_at, file_name, file_bytes, raw_bytes, item_count, event_count, sha256, frames_json, rows_deleted)
      VALUES (${threadId}, 'archived', ${row.archived_at}, ${fileName}, ${fileBytes}, ${rawBytes}, ${items.length}, ${events.length}, ${row.sha256}, ${row.frames_json}, 0)
    `;
    pending.add(threadId);
    yield* announce(threadId, "archived");
    yield* deleteArchivedRows(threadId, items, events);
    return { rawBytes, fileBytes };
  });

  const insertRow = (
    table: typeof TURN_ITEMS | typeof EVENTS,
    allowed: ReadonlySet<string>,
    row: Record<string, unknown>,
  ) => {
    const names = Object.keys(row).filter((name) => allowed.has(name));
    return sql.unsafe(
      `INSERT OR IGNORE INTO ${table} (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      names.map((name) => row[name]),
    );
  };

  const restoreLocked = Effect.fn("ThreadHistoryArchive.restoreLocked")(function* (
    threadId: string,
  ) {
    const row = yield* readArchiveRow(threadId);
    if (row === undefined || row.state === "deleted") {
      pending.delete(threadId);
      return false;
    }
    yield* sql`UPDATE orchestration_v2_thread_history_archives SET state = 'restoring' WHERE thread_id = ${threadId}`;
    // Inserts skip rows already present, so a restore cut short simply runs again.
    // Few commits, small transactions: rows go back in groups of RESTORE_ROWS or RESTORE_BYTES.
    yield* readArchive(row, (lines) =>
      Effect.gen(function* () {
        let start = 0;
        while (start < lines.length) {
          let end = start;
          let bytes = 0;
          while (end < lines.length && end - start < RESTORE_ROWS && bytes < RESTORE_BYTES) {
            bytes += lines[end]!.length;
            end++;
          }
          const group = lines.slice(start, end).map((line) => decodeLine(line));
          yield* sql.withTransaction(
            Effect.forEach(
              group,
              (line) =>
                line.t === "item"
                  ? insertRow(TURN_ITEMS, columns.item, line.r)
                  : insertRow(EVENTS, columns.event, line.r),
              { discard: true },
            ),
          );
          yield* Effect.yieldNow;
          start = end;
        }
      }),
    );
    yield* sql`DELETE FROM orchestration_v2_thread_history_archives WHERE thread_id = ${threadId}`;
    yield* fs.remove(path.join(directory, row.file_name)).pipe(Effect.ignore);
    pending.delete(threadId);
    yield* announce(threadId, null);
    return true;
  });

  const restore = Effect.fn("ThreadHistoryArchive.restore")(function* (threadId: string) {
    if (!pending.has(threadId)) return false;
    return yield* lock
      .withPermits(1)(restoreLocked(threadId))
      .pipe(Effect.mapError(fail("restore", threadId)));
  });

  gate.install((threadId) =>
    Effect.gen(function* () {
      if (!pending.has(threadId)) return;
      const now = yield* Clock.currentTimeMillis;
      if ((restoreFailedUntil.get(threadId) ?? 0) > now) return;
      yield* restore(threadId).pipe(
        Effect.catch((error) =>
          Effect.sync(() => restoreFailedUntil.set(threadId, now + RESTORE_RETRY_MS)).pipe(
            Effect.andThen(
              Effect.logWarning("Thread history restore failed; showing the thread without it", {
                threadId,
                error,
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
  );

  // Rows left behind by a pass that stopped midway, and copies a restore did not finish.
  const recover = Effect.fn("ThreadHistoryArchive.recover")(function* () {
    const rows = yield* sql<ArchiveRow>`
      SELECT thread_id, state, archived_at, file_name, sha256, frames_json, item_count, event_count, rows_deleted
      FROM orchestration_v2_thread_history_archives
      WHERE state = 'restoring' OR (state = 'archived' AND rows_deleted = 0)
    `;
    for (const row of rows) {
      if (row.state === "restoring") {
        yield* restoreLocked(row.thread_id);
        continue;
      }
      const items: ItemKey[] = [];
      const events: number[] = [];
      yield* readArchive(row, (lines) =>
        Effect.sync(() => {
          for (const text of lines) {
            const line = decodeLine(text);
            if (line.t === "event") events.push(Number(line.r.sequence));
            else
              items.push({ id: String(line.r.turn_item_id), updatedAt: String(line.r.updated_at) });
          }
        }),
      );
      yield* deleteArchivedRows(row.thread_id, items, events);
    }
  });

  const removeStrayFiles = Effect.fn("ThreadHistoryArchive.removeStrayFiles")(function* () {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    if (names.length === 0) return;
    const known = new Set(
      (yield* sql<{ readonly file_name: string }>`
        SELECT file_name FROM orchestration_v2_thread_history_archives WHERE state != 'deleted'
      `).map((row) => row.file_name),
    );
    for (const name of names)
      if (name.endsWith(".tmp") || (name.endsWith(".jsonl.zst") && !known.has(name)))
        yield* fs.remove(path.join(directory, name)).pipe(Effect.ignore);
  });

  const deleteExpired = Effect.fn("ThreadHistoryArchive.deleteExpired")(function* (before: string) {
    const rows = yield* sql<{ readonly thread_id: string; readonly file_name: string }>`
      SELECT thread_id, file_name FROM orchestration_v2_thread_history_archives
      WHERE state = 'archived' AND rows_deleted = 1 AND archived_at < ${before}
    `;
    for (const row of rows) {
      // The row changes first: a crash before the file goes leaves only a stray file to sweep.
      yield* sql`UPDATE orchestration_v2_thread_history_archives SET state = 'deleted', file_bytes = 0 WHERE thread_id = ${row.thread_id}`;
      pending.delete(row.thread_id);
      yield* announce(row.thread_id, "deleted");
      yield* fs.remove(path.join(directory, row.file_name)).pipe(Effect.ignore);
    }
    return rows.length;
  });

  const runPass = Effect.fn("ThreadHistoryArchive.runPass")(function* (
    policy: ThreadHistoryArchivePolicy,
  ) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* recover();
          yield* removeStrayFiles();
          let archivedThreads = 0;
          let archivedRawBytes = 0;
          let archiveFileBytes = 0;
          if (policy.archiveAfterDays !== null) {
            const idleBefore = DateTime.formatIso(
              DateTime.makeUnsafe(policy.now - policy.archiveAfterDays * 86_400_000),
            );
            let afterAt = "";
            let afterId = "";
            while (true) {
              const page = yield* sql<{ readonly thread_id: string; readonly updated_at: string }>`
              SELECT thread_id, updated_at FROM orchestration_v2_projection_threads
              WHERE updated_at < ${idleBefore} AND (updated_at, thread_id) > (${afterAt}, ${afterId})
              ORDER BY updated_at, thread_id LIMIT ${PAGE_ROWS}
            `;
              for (const thread of page) {
                const result = yield* archiveThread(thread.thread_id, policy.now);
                if (result === undefined) continue;
                archivedThreads++;
                archivedRawBytes += result.rawBytes;
                archiveFileBytes += result.fileBytes;
              }
              if (page.length < PAGE_ROWS) break;
              afterAt = page.at(-1)!.updated_at;
              afterId = page.at(-1)!.thread_id;
            }
          }
          const deletedArchives =
            policy.deleteAfterDays === null
              ? 0
              : yield* deleteExpired(
                  DateTime.formatIso(
                    DateTime.makeUnsafe(policy.now - policy.deleteAfterDays * 86_400_000),
                  ),
                );
          return { archivedThreads, archivedRawBytes, archiveFileBytes, deletedArchives };
        }),
      )
      .pipe(Effect.mapError(fail("pass")));
  });

  const stats = sql<{ readonly threads: number; readonly bytes: number | null }>`
    SELECT count(*) AS threads, sum(file_bytes) AS bytes FROM orchestration_v2_thread_history_archives WHERE state != 'deleted'
  `.pipe(
    Effect.map((rows) => ({ threads: rows[0]?.threads ?? 0, fileBytes: rows[0]?.bytes ?? 0 })),
    Effect.mapError(fail("stats")),
  );

  return ThreadHistoryArchive.of({
    runPass,
    restore,
    stats,
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(ThreadHistoryArchive, make);
