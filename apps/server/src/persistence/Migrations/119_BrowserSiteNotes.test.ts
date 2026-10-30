import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("119_BrowserSiteNotes", (it) => {
  it.effect("upgrades existing databases and enforces note authors and unique origins", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 118 });
      assert.deepStrictEqual(yield* runMigrations(), [[119, "BrowserSiteNotes"]]);
      yield* sql`INSERT INTO browser_site_notes (origin, text, author, updated_at)
        VALUES ('https://example.com', 'note', 'person', '2026-10-30T00:00:00Z')`;
      yield* sql`INSERT INTO browser_site_note_seed_hidden (origin) VALUES ('https://example.com')`;
      const invalid = yield* sql`INSERT INTO browser_site_notes (origin, text, author, updated_at)
        VALUES ('https://other.example', 'note', 'unknown', '2026-10-30T00:00:00Z')`.pipe(
        Effect.result,
      );
      assert.strictEqual(invalid._tag, "Failure");
      const duplicate = yield* sql`INSERT INTO browser_site_note_seed_hidden (origin)
        VALUES ('https://example.com')`.pipe(Effect.result);
      assert.strictEqual(duplicate._tag, "Failure");
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
