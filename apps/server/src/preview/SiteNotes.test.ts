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
          assert.strictEqual(
            result._tag === "Failure" && result.failure._tag === "SiteNoteError"
              ? result.failure.reason
              : undefined,
            text.startsWith("한") ? "too_large" : "secret",
          );
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
    "password is hunter",
    "password is under123",
    "password is shown but token is hunter",
    "my password is hunter",
    "PIN: abcd",
    "token is supersecret",
    "the passcode is letmein",
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
        assert.strictEqual(
          result._tag === "Failure" && result.failure._tag === "SiteNoteError"
            ? result.failure.reason
            : undefined,
          "secret",
        );
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect.each([
    "password: under Settings",
    "The token is shown once after you create it",
    "Your PIN is required at checkout",
    "The password is not stored by the site",
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
  it.effect.each([
    ["github token", `ghp_${"a".repeat(36)}`],
    ["github fine-grained token", `github_pat_${"a".repeat(22)}`],
    ["github oauth token", `gho_${"a".repeat(36)}`],
    ["provider key", `sk-${"a".repeat(32)}`],
    ["provider variant key", `sk-ant-api03-${"a".repeat(40)}`],
    ["access key", `AKIA${"A1".repeat(8)}`],
    [
      "JWT",
      `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.eyJzdWIiOiIxMjMifQ.c2ln`,
    ],
    [
      "JWE",
      `${Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString("base64url")}..aXY.Y2lwaGVydGV4dA.dGFn`,
    ],
    ["private key header", "-----BEGIN PRIVATE KEY-----"],
    ["openssh private key header", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ] satisfies Array<[string, string]>)("refuses secret shape: %s", ([_name, text]) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const result = yield* Effect.result(
          notes.write({ origin: "https://example.com", text, author: "person" }),
        );
        assert.strictEqual(
          result._tag === "Failure" && result.failure._tag === "SiteNoteError"
            ? result.failure.reason
            : undefined,
          "secret",
        );
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect.each([
    "see docs.example.com/v1.2.3",
    "file serverLogger.test.ts",
    "version 1.0.0-beta.2",
  ])("allows dotted ordinary text: %s", (text) =>
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
  it.effect("evicts the least recently used thread and requires a new touch", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const origin = "https://github.com";
        for (let i = 0; i < 512; i++) assert.isDefined(notes.deliverOnce(`thread-${i}`, origin));
        assert.isTrue(notes.hasTouched("thread-0", origin));
        assert.isDefined(notes.deliverOnce("thread-512", origin));
        assert.isFalse(notes.hasTouched("thread-1", origin));
        const result = yield* Effect.result(
          notes.writeAgent("thread-1", { origin, text: "guide" }),
        );
        assert.strictEqual(
          result._tag === "Failure" && result.failure._tag === "SiteNoteError"
            ? result.failure.reason
            : undefined,
          "untouched",
        );
        assert.isTrue(notes.hasTouched("thread-0", origin));
        assert.isTrue(notes.hasTouched("thread-512", origin));
        assert.strictEqual(
          Array.from({ length: 513 }, (_, i) => notes.hasTouched(`thread-${i}`, origin)).filter(
            Boolean,
          ).length,
          512,
        );
        assert.isDefined(notes.deliverOnce("thread-1", origin));
        assert.isTrue(notes.hasTouched("thread-1", origin));
        yield* notes.writeAgent("thread-1", { origin, text: "guide" });
      }).pipe(Effect.provide(SiteNotes.layer));
    }),
  );
  it.effect("evicts least recently used origins and permits redelivery", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* Effect.gen(function* () {
        const notes = yield* SiteNotes.SiteNotes;
        const thread = "origin-thread";
        const seeded = "https://github.com";
        assert.isDefined(notes.deliverOnce(thread, seeded));
        for (let i = 0; i < 255; i++) notes.deliverOnce(thread, `https://site-${i}.example`);
        assert.isTrue(notes.hasTouched(thread, seeded));
        notes.deliverOnce(thread, "https://site-255.example");
        assert.isFalse(notes.hasTouched(thread, "https://site-0.example"));
        assert.isTrue(notes.hasTouched(thread, seeded));
        assert.isTrue(notes.hasTouched(thread, "https://site-255.example"));
        assert.strictEqual(
          [seeded, ...Array.from({ length: 256 }, (_, i) => `https://site-${i}.example`)].filter(
            (origin) => notes.hasTouched(thread, origin),
          ).length,
          256,
        );
        for (let i = 256; i < 512; i++) notes.deliverOnce(thread, `https://site-${i}.example`);
        assert.isFalse(notes.hasTouched(thread, seeded));
        assert.isDefined(notes.deliverOnce(thread, seeded));
        assert.isUndefined(notes.deliverOnce(thread, seeded));
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
