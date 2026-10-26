import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadArchiveGate from "./ThreadArchiveGate.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchive.ts";

const now = Date.parse("2026-10-22T00:00:00.000Z");
const day = 86_400_000;
const items = 40;
const policy = { archiveAfterDays: 30, deleteAfterDays: null, now };

// A fresh slot per test: the archive fills it and the projection store reads through it.
const layer = () =>
  Layer.mergeAll(ThreadHistoryArchive.layer, ProjectionStore.layer).pipe(
    Layer.provide(
      Layer.succeed(
        ThreadArchiveGate.ThreadArchiveGate,
        ThreadArchiveGate.makeThreadArchiveGateSlot(),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "thread-archive-" })),
    Layer.provideMerge(NodeServices.layer),
  );

// "old" idle 40 days, "waiting" idle 40 days with a handoff someone still waits on, "recent" 5 days.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [threadId, idleDays, liveLast] of [
    ["old", 40, false],
    ["waiting", 40, true],
    ["recent", 5, false],
  ] as const) {
    const at = DateTime.formatIso(DateTime.makeUnsafe(now - idleDays * day));
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', ${threadId}, 'codex', 'full-access', 'default', ${at}, ${at}, '{}')`;
    for (let n = 0; n < items; n++) {
      const id = `${threadId}:item-${n}`;
      // The last item: a handoff someone waits on, or a todo list left running on a
      // finished thread, which nobody waits on.
      const last = n === items - 1;
      const status = last ? (liveLast ? "waiting" : "running") : "completed";
      const type = last ? (liveLast ? "human_handoff" : "todo_list") : "command_execution";
      const output = `out-${n}-` + "x".repeat(n * 997);
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${threadId}, ${n}, ${type}, ${status}, ${at}, json_object('id', ${id}, 'type', ${type}, 'output', ${output}))`;
      yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (${threadId}, ${id}, ${n})`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${id + ":event"}, 'thread', ${threadId}, ${n + 1}, 'turn-item.updated', ${at}, 'provider', json_object('id', ${id}, 'output', ${output}), '{}', 2)`;
    }
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (${threadId + ":message"}, 'thread', ${threadId}, ${items + 1}, 'message.updated', ${at}, 'user', '{"id":"m"}', '{}', 2)`;
  }
});

const rows = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      items:
        yield* sql`SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} ORDER BY turn_item_id`,
      events:
        yield* sql`SELECT * FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`,
      positions:
        yield* sql`SELECT * FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId} ORDER BY ordinal`,
    };
  });

const archiveFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return yield* fs
    .readDirectory(path.join(path.dirname(config.dbPath), "thread-archive"))
    .pipe(Effect.orElseSucceed(() => []));
});

const archiveState = (threadId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly state: string; readonly rows_deleted: number }>`
      SELECT state, rows_deleted FROM orchestration_v2_thread_history_archives WHERE thread_id = ${threadId}`,
  ).pipe(Effect.map((result) => result[0]));

// Fails the nth statement matching pattern, as a process killed at that step would leave it.
const crashAt = (pattern: RegExp, nth = 1): Statement.Transformer => {
  let seen = 0;
  return (statement) =>
    pattern.test(statement.compile()[0]) && ++seen === nth
      ? Effect.die("simulated crash")
      : Effect.succeed(statement);
};

it.effect("archives idle threads and restores them on read, row for row", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* seed;
    const before = {
      old: yield* rows("old"),
      waiting: yield* rows("waiting"),
      recent: yield* rows("recent"),
    };
    const pass = yield* archive.runPass(policy);
    assert.equal(pass.archivedThreads, 1);
    assert.isBelow(pass.archiveFileBytes, pass.archivedRawBytes / 4);
    const archived = yield* rows("old");
    assert.equal(archived.items.length, 0);
    assert.deepEqual(
      archived.events.map((event) => event.event_type),
      ["message.updated"],
    );
    assert.deepEqual(archived.positions, before.old.positions);
    assert.deepEqual(yield* archiveState("old"), { state: "archived", rows_deleted: 1 });
    assert.equal((yield* archiveFiles).length, 1);
    // Someone still waits on "waiting"; "recent" is not idle long enough.
    assert.deepEqual(yield* rows("waiting"), before.waiting);
    assert.deepEqual(yield* rows("recent"), before.recent);
    assert.deepEqual(yield* archive.stats, { threads: 1, fileBytes: pass.archiveFileBytes });

    // Opening the thread restores it before the read answers.
    const snapshot = yield* store.getThreadSnapshot("old" as never).pipe(Effect.exit);
    assert.isTrue(Exit.isSuccess(snapshot) || Exit.isFailure(snapshot));
    assert.deepEqual(yield* rows("old"), before.old);
    assert.isUndefined(yield* archiveState("old"));
    assert.deepEqual(yield* archiveFiles, []);
  }).pipe(Effect.provide(layer())),
);

it.effect("a pass killed before the index row is written leaves the thread whole and retries", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    yield* seed;
    const before = yield* rows("old");
    const crashed = yield* archive
      .runPass(policy)
      .pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          crashAt(/INSERT INTO orchestration_v2_thread_history_archives/u),
        ),
        Effect.exit,
      );
    assert.isTrue(Exit.isFailure(crashed));
    assert.deepEqual(yield* rows("old"), before);
    assert.isUndefined(yield* archiveState("old"));
    // The next pass sweeps the orphaned file and archives again.
    assert.equal((yield* archive.runPass(policy)).archivedThreads, 1);
    assert.equal((yield* archiveFiles).length, 1);
    assert.isTrue(yield* archive.restore("old"));
    assert.deepEqual(yield* rows("old"), before);
  }).pipe(Effect.provide(layer())),
);

it.effect("a pass killed between deletes finishes them on the next pass without losing rows", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    yield* seed;
    const before = yield* rows("old");
    const crashed = yield* archive
      .runPass(policy)
      .pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          crashAt(/DELETE FROM orchestration_v2_projection_turn_items/u, 3),
        ),
        Effect.exit,
      );
    assert.isTrue(Exit.isFailure(crashed));
    assert.deepEqual(yield* archiveState("old"), { state: "archived", rows_deleted: 0 });
    const partial = (yield* rows("old")).items.length;
    assert.isAbove(partial, 0);
    assert.isBelow(partial, items);
    yield* archive.runPass(policy);
    assert.deepEqual(yield* archiveState("old"), { state: "archived", rows_deleted: 1 });
    assert.equal((yield* rows("old")).items.length, 0);
    assert.isTrue(yield* archive.restore("old"));
    assert.deepEqual(yield* rows("old"), before);
  }).pipe(Effect.provide(layer())),
);

it.effect("a restore killed midway completes when it runs again", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    yield* seed;
    const before = yield* rows("old");
    yield* archive.runPass(policy);
    const crashed = yield* archive
      .restore("old")
      .pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          crashAt(/INSERT OR IGNORE INTO orchestration_events/u, 10),
        ),
        Effect.exit,
      );
    assert.isTrue(Exit.isFailure(crashed));
    assert.deepEqual(yield* archiveState("old"), { state: "restoring", rows_deleted: 1 });
    assert.isTrue(yield* archive.restore("old"));
    assert.deepEqual(yield* rows("old"), before);
    assert.deepEqual(yield* archiveFiles, []);
  }).pipe(Effect.provide(layer())),
);

it.effect("no archive statement reaches past one small page", () => {
  const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
  const record: Statement.Transformer = (statement) => {
    statements.push(statement.compile() as readonly [string, ReadonlyArray<unknown>]);
    return Effect.succeed(statement);
  };
  return Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    yield* seed;
    yield* archive
      .runPass(policy)
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    yield* archive.restore("old").pipe(Effect.provideService(Statement.CurrentTransformer, record));
    for (const [query, params] of statements) {
      if (!/orchestration_events|orchestration_v2_projection_turn_items/u.test(query)) continue;
      const inList = /\bIN \(([?, ]+)\)/u.exec(query);
      const limit = /\bLIMIT \?/u.test(query) ? Number(params.at(-1)) : undefined;
      const oneRow =
        /WHERE (sequence|turn_item_id) = \?/u.test(query) ||
        /^\s*INSERT OR IGNORE INTO/u.test(query);
      assert.isTrue(
        (limit !== undefined && limit <= 16) ||
          (inList !== null && inList[1]!.split(",").length <= 16) ||
          oneRow,
        query.replace(/\s+/gu, " "),
      );
    }
  }).pipe(Effect.provide(layer()));
});

it.effect("the hard-delete policy removes old archives only when it is set", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    yield* seed;
    yield* archive.runPass(policy);
    const later = { ...policy, now: now + 400 * day };
    assert.equal((yield* archive.runPass(later)).deletedArchives, 0);
    assert.equal((yield* archive.runPass({ ...later, deleteAfterDays: 365 })).deletedArchives, 1);
    assert.deepEqual(yield* archiveState("old"), { state: "deleted", rows_deleted: 1 });
    // By day 400 "recent" went idle too and was archived in the first later pass; it is younger
    // than the deletion window, so only its archive remains.
    assert.equal((yield* archiveFiles).length, 1);
    assert.equal((yield* archive.stats).threads, 1);
    assert.deepEqual(yield* archiveState("recent"), { state: "archived", rows_deleted: 1 });
    assert.isFalse(yield* archive.restore("old"));
  }).pipe(Effect.provide(layer())),
);

it.effect("finds text only archived history holds, for threads that are not deleted", () =>
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const before = yield* archive.snapshotKey;
    yield* archive.runPass(policy);
    // Archiving moved history out of the database; a check spanning it can tell.
    assert.notEqual(yield* archive.snapshotKey, before);
    assert.deepEqual(yield* rows("old").pipe(Effect.map((old) => old.items.length)), 0);
    const needles = ["old:item-7", "nowhere-at-all"];
    assert.deepEqual([...((yield* archive.mentions(needles, 1024 ** 3)) ?? [])], ["old:item-7"]);
    // More archived history than the caller may read: it learns nothing rather than "no".
    assert.isNull(yield* archive.mentions(needles, 1));
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-21T00:00:00.000Z' WHERE thread_id = 'old'`;
    assert.deepEqual([...((yield* archive.mentions(needles, 1024 ** 3)) ?? ["unread"])], []);
  }).pipe(Effect.provide(layer())),
);
