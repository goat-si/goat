import * as AuxiliarySqlite from "../../storage/AuxiliarySqlite.ts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off -- synthetic SQLite file fixture only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { classifyImessageDbError, openImessageChatDb } from "./imessageChatDb.ts";

describe("iMessage read-only chat database", () => {
  it.effect("orders rows, bounds scans, and counts joins without write access", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-db-"));
      const path = NodePath.join(dir, "fixture.sqlite");
      try {
        const writer = new NodeSqlite.DatabaseSync(path);
        writer.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
        is_from_me INTEGER, date INTEGER, date_read INTEGER, cache_roomnames TEXT,
        associated_message_type INTEGER, item_type INTEGER, balloon_bundle_id TEXT);
        CREATE TABLE handle (id TEXT, service TEXT);
        CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
        CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);`);
        writer.exec(
          "INSERT INTO handle VALUES ('+15550000000','iMessage'); INSERT INTO chat VALUES ('iMessage;-;+15550000000','+15550000000',45);",
        );
        for (let i = 1; i <= 3; i++)
          writer
            .prepare(
              "INSERT INTO message (guid,text,handle_id,is_from_me,date,item_type) VALUES (?,?,?,?,?,?)",
            )
            .run("g" + i, "hello", 1, 0, 0, 0);
        writer.exec(
          "INSERT INTO chat_message_join VALUES (2,1); INSERT INTO chat_message_join VALUES (3,1); INSERT INTO chat_message_join VALUES (3,1);",
        );
        writer
          .prepare("UPDATE message SET attributedBody = ? WHERE ROWID = 1")
          .run(new Uint8Array([0, 255, 1]));
        writer.close();
        const reader = yield* openImessageChatDb(path);
        expect(yield* reader.maxRowId()).toBe(3);
        expect((yield* reader.rowsAfter(0, 2)).map((row) => row.rowid)).toEqual([1, 2]);
        expect((yield* reader.rowById(1))?.chat_join_count).toBe(0);
        expect((yield* reader.rowById(1))?.attributedBody).toEqual(new Uint8Array([0, 255, 1]));
        expect((yield* reader.rowById(2))?.chat_join_count).toBe(1);
        expect((yield* reader.rowById(3))?.chat_join_count).toBe(2);
        const readonly = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        expect(() => readonly.exec("DELETE FROM message")).toThrow();
        readonly.close();
        yield* reader.close();
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(AuxiliarySqlite.layer)),
  );
  it.effect("classifies inaccessible and unsupported schema separately", () =>
    Effect.gen(function* () {
      expect(classifyImessageDbError({ code: "EACCES" })).toBe("database_unavailable");
      expect(classifyImessageDbError(new Error("no such column: h.service"))).toBe(
        "schema_unsupported",
      );
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-schema-"));
      const path = NodePath.join(dir, "empty.sqlite");
      try {
        const writer = new NodeSqlite.DatabaseSync(path);
        writer.close();
        const result = yield* Effect.result(openImessageChatDb(path));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.category).toBe("schema_unsupported");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(AuxiliarySqlite.layer)),
  );
});

it.effect("opens and reads Messages without parent-thread native statements", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-offloop-"));
    try {
      const file = NodePath.join(dir, "fixture.sqlite");
      const seed = new NodeSqlite.DatabaseSync(file);
      try {
        seed.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
          is_from_me INTEGER, date INTEGER, date_read INTEGER, cache_roomnames TEXT,
          associated_message_type INTEGER, item_type INTEGER, balloon_bundle_id TEXT);
          CREATE TABLE handle (id TEXT, service TEXT);
          CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
          CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
          INSERT INTO message (guid,text,is_from_me,date,item_type) VALUES ('invented-guid','hello',0,0,0)`);
      } finally {
        seed.close();
      }
      using prepare = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare");
      const reader = yield* openImessageChatDb(file);
      try {
        expect(yield* reader.maxRowId()).toBe(1);
        expect((yield* reader.rowsAfter(0, 50)).map((row) => row.rowid)).toEqual([1]);
        expect((yield* reader.rowById(1))?.guid).toBe("invented-guid");
      } finally {
        yield* reader.close();
      }
      expect(prepare.mock.calls).toHaveLength(0);
      prepare.mockRestore();
      const oversized = new NodeSqlite.DatabaseSync(file);
      try {
        oversized
          .prepare("UPDATE message SET attributedBody = ?")
          .run(new Uint8Array(8 * 1024 * 1024 + 1));
      } finally {
        oversized.close();
      }
      const tooLarge = yield* Effect.result(reader.rowsAfter(0, 50));
      expect(tooLarge._tag).toBe("Failure");
      if (tooLarge._tag === "Failure") expect(tooLarge.failure.category).toBe("query_failed");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(AuxiliarySqlite.layer)),
);
