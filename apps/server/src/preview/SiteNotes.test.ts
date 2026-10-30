import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { MemoryAccessError } from "../memory/MemoryService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { browserGuideFor } from "./BrowserGuide.ts";
import * as SiteNotes from "./SiteNotes.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("SiteNotes", (it) => {
  it.effect("persists edits, hides deleted seeds, and restores them", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const origin = "https://github.com";
        const seed = notes.noteFor(origin);
        assert.isDefined(seed);
        yield* notes.write({ origin, text: "My note", author: "person" });
        assert.strictEqual(notes.noteFor(origin)?.text, "My note");
        yield* notes.delete(origin);
        assert.isUndefined(notes.noteFor(origin));
        assert.isTrue(notes.list().find((entry) => entry.origin === origin)?.hidden);
        yield* notes.restoreSeed(origin);
        assert.deepStrictEqual(notes.noteFor(origin), seed);
      }).pipe(Effect.provide(SiteNotes.layer));
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        assert.isDefined(notes.noteFor("https://github.com"));
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("rejects oversized UTF-8 and secret-bearing notes", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        for (const text of [
          "한".repeat(342),
          "password: example-secret",
          `ghp_${"a".repeat(30)}`,
        ]) {
          const result = yield* Effect.result(
            notes.write({ origin: "https://example.com", text, author: "agent" }),
          );
          assert.strictEqual(result._tag, "Failure");
        }
        yield* notes.write({
          origin: "https://example.com",
          text: "한".repeat(341),
          author: "agent",
        });
        assert.strictEqual(notes.noteFor("https://example.com")?.text.length, 341);
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect.each([
    "my password is hunter2",
    "API key is sk-abc123def456",
    "token=abc123",
    "Login: me / password: hunter2",
    "The PIN is 4821",
    "secret: Zx9!",
    "password is correcthorsebatterystaple",
    "passwd is a1",
    "passcode: a1",
    "api_key=a1",
    "api-key is a1",
    "access key is a1",
    "private key: a1",
  ])("refuses credential-like text: %s", (text) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const result = yield* Effect.result(
          notes.write({ origin: "https://example.com", text, author: "person" }),
        );
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect.each([
    "The API key is under Settings > Developer",
    "Password reset lives at /account/reset",
    "Tokens expire after an hour",
    "Use the secret menu in the footer",
    "The password field is on the second step",
  ])("allows ordinary prose: %s", (text) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        yield* notes.write({ origin: "https://example.com", text, author: "person" });
        assert.strictEqual(notes.noteFor("https://example.com")?.text, text);
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("delivers an origin once per thread, including simultaneous touches", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const results = yield* Effect.all(
          Array.from({ length: 10 }, () =>
            Effect.sync(() => notes.deliverOnce("thread-a", "https://github.com/path")),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter((value) => value !== undefined).length, 1);
        assert.isDefined(notes.deliverOnce("thread-b", "https://github.com"));
        assert.isUndefined(notes.deliverOnce("thread-a", "https://github.com"));
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("bounds delivery of oversized stored UTF-8 text without splitting a character", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const text = "한".repeat(400);
      yield* sql`INSERT INTO browser_site_notes (origin, text, author, updated_at)
        VALUES ('https://long.example', ${text}, 'person', '2026-10-30T00:00:00Z')`;
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const delivered = notes.deliverOnce("thread", "https://long.example");
        assert.strictEqual(delivered?.split("\n")[1], "한".repeat(341));
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("shares once-per-origin delivery between the browser guide and screen bindings", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const first = browserGuideFor(
          undefined,
          "guide-first",
          "https://github.com",
          notes.deliverOnce,
        );
        assert.include(first ?? "", "Site notes for https://github.com");
        assert.isUndefined(notes.deliverOnce("guide-first", "https://github.com"));
        assert.isDefined(notes.deliverOnce("screen-first", "https://github.com"));
        assert.isUndefined(
          browserGuideFor(undefined, "screen-first", "https://github.com", notes.deliverOnce),
        );
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("refuses agent writes until that thread has touched the origin", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const input = { origin: "https://touched.example", text: "procedure" };
        assert.strictEqual((yield* Effect.result(notes.writeAgent("one", input)))._tag, "Failure");
        notes.deliverOnce("one", "https://touched.example/page");
        assert.strictEqual((yield* Effect.result(notes.writeAgent("two", input)))._tag, "Failure");
        yield* notes.writeAgent("one", input);
        assert.strictEqual(notes.noteFor(input.origin)?.author, "agent");
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("refuses a revoked person permission before changing stored notes", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const permit = Effect.fail(new MemoryAccessError({ code: "unavailable" }));
        const result = yield* Effect.result(
          notes.write({ origin: "https://denied.example", text: "note", author: "person" }, permit),
        );
        assert.strictEqual(result._tag, "Failure");
        assert.isUndefined(notes.noteFor("https://denied.example"));
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
});
