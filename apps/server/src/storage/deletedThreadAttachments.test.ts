import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { ThreadHistoryArchive } from "../orchestration-v2/ThreadHistoryArchive.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deletedThreadAttachments } from "./deletedThreadAttachments.ts";
import { survivorMentions } from "./survivorMentions.ts";

const fixture = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  Layer.mock(ThreadHistoryArchive)({
    snapshotKey: Effect.succeed("stable"),
    mentions: () => Effect.succeed(new Set<string>()),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const gone = { id: "thread-gone", deleted: "2026-01-01" };
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const now = 2 * 86_400_000;
const attachment = Effect.fn("test.attachment")(function* (segment = gone.id) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "survivor-" });
  const file = path.join(dir, `${segment}-11111111-1111-4111-8111-111111111111.png`);
  yield* fs.writeFileString(file, "image");
  yield* fs.utimes(file, 0, 0);
  return {
    fs,
    dir,
    file,
    scan: deletedThreadAttachments({ attachmentsDir: dir, now, threads: [gone] }),
  };
});

const thread = Effect.fn("test.thread")(function* (payload = "{}", deleted: string | null = null) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
     created_at, updated_at, deleted_at, payload_json)
    VALUES ('live', 'project', 'Live', 'codex', 'full-access', 'default',
      '2026-01-01', '2026-01-01', ${deleted}, ${payload})`;
});

const referenceSources = [
  {
    name: "surviving thread payload",
    table: "orchestration_v2_projection_threads",
    field: "payload_json",
    values: {
      thread_id: "other",
      project_id: "project",
      title: "Live",
      default_provider: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    },
  },
  {
    name: "surviving message payload",
    table: "orchestration_v2_projection_messages",
    field: "payload_json",
    values: {
      message_id: "message",
      thread_id: "live",
      role: "user",
      streaming: 0,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    },
  },
  {
    name: "surviving turn item payload",
    table: "orchestration_v2_projection_turn_items",
    field: "payload_json",
    values: {
      turn_item_id: "item",
      thread_id: "live",
      ordinal: 1,
      type: "tool",
      status: "completed",
      updated_at: "2026-01-01",
    },
  },
  ...["source_thread_id", "target_thread_id", "payload_json"].map((field) => ({
    name: `context transfer ${field}`,
    table: "orchestration_v2_projection_context_transfers",
    field,
    values: {
      context_transfer_id: "transfer",
      source_thread_id: "source",
      target_thread_id: "target",
      type: "fork",
      status: "completed",
      updated_at: "2026-01-01",
      payload_json: "{}",
    },
  })),
  {
    name: "context handoff payload",
    table: "orchestration_v2_projection_context_handoffs",
    field: "payload_json",
    values: {
      context_handoff_id: "handoff",
      thread_id: "live",
      target_run_id: "run",
      to_provider_thread_id: "provider",
      strategy: "resume",
      status: "completed",
      updated_at: "2026-01-01",
    },
  },
  ...["pending", "running"].map((status) => ({
    name: `${status} outbox payload`,
    table: "orchestration_v2_effect_outbox",
    field: "payload_json",
    values: {
      effect_id: "effect",
      command_id: "command",
      thread_id: "live",
      effect_type: "test",
      status,
      available_at: "2026-01-01",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    },
  })),
  {
    name: "MCP model context",
    table: "mcp_app_model_context",
    field: "text",
    values: {
      thread_id: "live",
      item_id: "item",
      server: "server",
      tool: "tool",
      updated_at: "2026-01-01",
    },
  },
  {
    name: "disabled scheduled prompt",
    table: "scheduled_tasks",
    field: "prompt",
    values: {
      task_id: "task",
      title: "Task",
      enabled: 0,
      schedule_json: "{}",
      project_id: "project",
      workspace_strategy_json: "{}",
      model_selection_json: "{}",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "test",
      creation_source: "test",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      last_run_status: "idle",
      run_count: 0,
    },
  },
];

it.effect.each(referenceSources)("keeps attachments referenced by $name", (source) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, fs, file } = yield* attachment();
    yield* thread();
    yield* sql`INSERT INTO ${sql(source.table)} ${sql.insert({ ...source.values, [source.field]: source.field === "payload_json" ? encodeJson({ reference: gone.id }) : gone.id })}`;
    const result = yield* scan;
    assert.equal(result.removable.length, 0);
    assert.equal(result.kept.count, 1);
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("keeps attachments when a survivor payload exceeds the bounded scan", () =>
  Effect.gen(function* () {
    const { scan, fs, file } = yield* attachment();
    yield* thread(encodeJson({ text: "x".repeat(20_000) }));
    const result = yield* scan;
    assert.equal(result.removable.length, 0);
    assert.equal(result.kept.count, 1);
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("examines the whole needle set with one paged pass over each survivor source", () =>
  Effect.gen(function* () {
    const { fs, dir } = yield* attachment();
    const path = yield* Path.Path;
    const threads = Array.from({ length: 40 }, (_, i) => ({
      id: `gone-${i}`,
      deleted: "2026-01-01",
    }));
    for (const item of threads) {
      const file = path.join(dir, `${item.id}-11111111-1111-4111-8111-111111111111.png`);
      yield* fs.writeFileString(file, "image");
      yield* fs.utimes(file, 0, 0);
    }
    let reads = 0;
    const record: Statement.Transformer = (statement) => {
      if (/\bSELECT\b/u.test(statement.compile()[0])) reads++;
      return Effect.succeed(statement);
    };
    const result = yield* deletedThreadAttachments({ attachmentsDir: dir, now, threads }).pipe(
      Effect.provideService(Statement.CurrentTransformer, record),
    );
    assert.equal(result.removable.length, 40);
    assert.isAtMost(reads, 20);
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("keeps attachments after the total physical row budget is exhausted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan } = yield* attachment();
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2049)
      INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, deleted_at, payload_json)
      SELECT 'deleted-' || i, 'project', 'Deleted', 'codex', 'full-access', 'default',
        '2026-01-01', '2026-01-01', '2026-01-01', '{}' FROM n`;
    const result = yield* scan;
    assert.equal(result.removable.length, 0);
    assert.equal(result.kept.count, 1);
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("keeps attachments after the total character budget is exhausted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan } = yield* attachment();
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<513)
      INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, payload_json)
      SELECT 'live-' || i, 'project', 'Live', 'codex', 'full-access', 'default',
        '2026-01-01', '2026-01-01', ${"x".repeat(16_384)} FROM n`;
    assert.equal((yield* scan).removable.length, 0);
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("offers an unreferenced file again after an oversized survivor becomes bounded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, fs, file } = yield* attachment();
    yield* thread("x".repeat(20_000));
    assert.equal((yield* scan).kept.count, 1);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}'`;
    assert.deepEqual(
      (yield* scan).removable.map((item) => item.path),
      [file],
    );
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("ignores deleted history and completed outbox work within the physical budget", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, file } = yield* attachment();
    yield* thread(encodeJson({ reference: gone.id }), "2026-01-01");
    for (const source of referenceSources.filter(
      (item) =>
        item.table.endsWith("_messages") ||
        item.table.endsWith("_turn_items") ||
        item.table.endsWith("_outbox"),
    )) {
      yield* sql`INSERT OR REPLACE INTO ${sql(source.table)} ${sql.insert({
        ...source.values,
        [source.field]:
          source.field === "payload_json" ? encodeJson({ reference: gone.id }) : gone.id,
        ...(source.table.endsWith("_outbox") ? { status: "succeeded" } : {}),
      })}`;
    }
    assert.deepEqual(
      (yield* scan).removable.map((item) => item.path),
      [file],
    );
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect(
  "keeps attachments on a missing survivor source instead of accepting negative proof",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { scan, fs, file } = yield* attachment();
      yield* sql`ALTER TABLE scheduled_tasks RENAME TO unavailable_tasks`;
      assert.equal((yield* scan).kept.count, 1);
      assert.isTrue(yield* fs.exists(file));
    }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect.each(["mentioned", "unknown", "changed", "missing snapshot"])(
  "keeps attachments when archived history is %s",
  (state) =>
    Effect.gen(function* () {
      const { scan, fs, file } = yield* attachment();
      let snapshots = 0;
      const archive = ThreadHistoryArchive.of({
        ...(yield* ThreadHistoryArchive),
        snapshotKey: Effect.sync(() => {
          snapshots++;
          return state === "missing snapshot"
            ? null
            : state === "changed" && snapshots > 1
              ? "after"
              : "before";
        }),
        mentions: () =>
          Effect.succeed(
            state === "unknown" ? null : new Set(state === "mentioned" ? [gone.id] : []),
          ),
      });
      const result = yield* scan.pipe(Effect.provideService(ThreadHistoryArchive, archive));
      assert.equal(result.removable.length, 0);
      assert.equal(result.kept.count, 1);
      assert.isTrue(yield* fs.exists(file));
    }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect.each(["sanitized", "truncated"])(
  "excludes files shared by deleted and live IDs after a %s segment collision",
  (collision) =>
    Effect.gen(function* () {
      const segment = collision === "truncated" ? "a".repeat(80) : "same-name";
      const { dir, fs, file } = yield* attachment(segment);
      const result = yield* deletedThreadAttachments({
        attachmentsDir: dir,
        now,
        threads: [
          {
            id: collision === "truncated" ? segment + "-gone" : "same/name",
            deleted: "2026-01-01",
          },
          { id: collision === "truncated" ? segment + "-live" : "same-name", deleted: null },
        ],
      });
      assert.equal(result.removable.length, 0);
      assert.isTrue(yield* fs.exists(file));
    }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("checks every full deleted ID sharing a truncated segment", () =>
  Effect.gen(function* () {
    const segment = "a".repeat(80);
    const { dir, file, fs } = yield* attachment(segment);
    const fullId = segment.toUpperCase() + "-SECOND";
    yield* thread(encodeJson({ reference: fullId }));
    const result = yield* deletedThreadAttachments({
      attachmentsDir: dir,
      now,
      threads: [
        { id: segment + "-first", deleted: "2026-01-01" },
        { id: fullId, deleted: "2026-01-01" },
      ],
    });
    assert.equal(result.kept.count, 1);
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("retains the 24-hour guard and revalidates only selected files", () =>
  Effect.gen(function* () {
    const { scan, file, fs, dir } = yield* attachment();
    yield* fs.utimes(file, 86_400, 86_400);
    const input = { attachmentsDir: dir, threads: [gone], now: now - 1 };
    assert.equal((yield* deletedThreadAttachments(input)).kept.count, 1);
    assert.deepEqual(
      (yield* scan).removable.map((item) => item.path),
      [file],
    );
    assert.equal(
      (yield* deletedThreadAttachments({ ...input, now, only: new Set() })).removable.length,
      0,
    );
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("keeps attachments referenced after a NUL in a text source", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, fs, file } = yield* attachment();
    yield* sql`INSERT INTO mcp_app_model_context
      (thread_id, item_id, server, tool, text, updated_at)
      VALUES ('live', 'item', 'server', 'tool', ${"prefix\u0000" + gone.id}, '2026-01-01')`;
    assert.equal((yield* scan).kept.count, 1);
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("keeps candidate groups beyond the forty-group admission limit", () =>
  Effect.gen(function* () {
    const { fs, dir } = yield* attachment();
    const path = yield* Path.Path;
    const threads = Array.from({ length: 41 }, (_, i) => ({
      id: `gone-${i}`,
      deleted: "2026-01-01",
    }));
    for (const item of threads) {
      const file = path.join(dir, `${item.id}-11111111-1111-4111-8111-111111111111.png`);
      yield* fs.writeFileString(file, "image");
      yield* fs.utimes(file, 0, 0);
    }
    const result = yield* deletedThreadAttachments({ attachmentsDir: dir, now, threads });
    assert.equal(result.removable.length, 40);
    assert.equal(result.kept.count, 1);
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

const pagedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<17)
    INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
     created_at, updated_at, payload_json)
    SELECT 'live-' || i, 'project', 'Live', 'codex', 'full-access', 'default',
      '2026-01-01', '2026-01-01', '{}' FROM n`;
});

it.effect("admits foreground reads between pages and preserves a last-page reference", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* pagedThreads;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = '{"reference":"gone"}' WHERE thread_id = 'live-17'`;
    const scanning = yield* Effect.forkChild(
      survivorMentions(
        ["gone", "absent"],
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(entered);
    assert.equal((yield* sql`SELECT 1 AS value`)[0]?.value, 1);
    yield* Deferred.succeed(release, undefined);
    const found = yield* Fiber.join(scanning);
    assert.isNotNull(found);
    assert.isTrue(found?.has("gone"));
    assert.isFalse(found?.has("absent"));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("invalidates negative proof after a same-connection mutation between pages", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, file, fs } = yield* attachment();
    yield* pagedThreads;
    const mutate = sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = ${encodeJson({ reference: gone.id })} WHERE thread_id = 'live-1'`.pipe(
      Effect.asVoid,
      Effect.orDie,
    );
    assert.isNull(yield* survivorMentions([gone.id], mutate));
    assert.equal((yield* scan).kept.count, 1);
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("invalidates negative proof after another connection commits between pages", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "survivor-db-" });
    const dbPath = path.join(dir, "state.sqlite");
    yield* Effect.gen(function* () {
      yield* pagedThreads;
      const external = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
        (db) => Effect.sync(() => db.close()),
      );
      const mutate = Effect.sync(() => {
        external.exec(`UPDATE orchestration_v2_projection_threads
          SET payload_json = '{"reference":"gone"}' WHERE thread_id = 'live-1'`);
      });
      assert.isNull(yield* survivorMentions(["gone"], mutate));
      assert.isTrue((yield* survivorMentions(["gone"]))?.has("gone"));
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("returns unknown when a full page has an unsafe rowid cursor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* pagedThreads;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET rowid = rowid + 9007199254740992`;
    assert.isNull(yield* survivorMentions(["absent"]));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("returns a positive match without requiring unread later sources", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* thread('{"reference":"gone"}');
    yield* sql`ALTER TABLE scheduled_tasks RENAME TO unavailable_tasks`;
    assert.deepEqual(yield* survivorMentions(["gone"]), new Set(["gone"]));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("does not query survivor sources for an empty candidate set", () =>
  Effect.gen(function* () {
    const rejectQuery: Statement.Transformer = () => Effect.die("Empty scans must not query SQL");
    assert.deepEqual(
      yield* survivorMentions([]).pipe(
        Effect.provideService(Statement.CurrentTransformer, rejectQuery),
      ),
      new Set<string>(),
    );
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("revalidates a selected file against references committed after review", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scan, dir, file, fs } = yield* attachment();
    assert.deepEqual(
      (yield* scan).removable.map((item) => item.path),
      [file],
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* thread(encodeJson({ reference: gone.id }));
        const fresh = yield* deletedThreadAttachments({
          attachmentsDir: dir,
          now,
          threads: [gone],
          only: new Set([file]),
        });
        assert.equal(fresh.removable.length, 0);
        assert.equal(fresh.kept.count, 1);
      }),
    );
    assert.isTrue(yield* fs.exists(file));
  }).pipe(Effect.provide(fixture), Effect.scoped),
);

it.effect("releases scan resources when interrupted between pages", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* pagedThreads;
    const scanning = yield* Effect.forkChild(
      survivorMentions(
        ["absent"],
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(scanning);
    assert.equal((yield* sql`SELECT 1 AS value`)[0]?.value, 1);
    assert.deepEqual(yield* survivorMentions(["absent"]), new Set<string>());
  }).pipe(Effect.provide(fixture), Effect.scoped),
);
