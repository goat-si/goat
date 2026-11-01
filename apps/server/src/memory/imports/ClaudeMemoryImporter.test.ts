import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseClaudeMemory } from "./ClaudeMemoryImporter.ts";
import {
  buildMemoryImportFixture,
  MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";
import type { ImportParsedItem, ImportSnapshot } from "./MemoryImportTypes.ts";

const decodePayload = Schema.decodeUnknownEffect(M.MemoryPayload);
const topic = (
  body = "Use focused checks.",
  fields = "name: Guidance\ndescription: A synthetic topic\ntype: project",
) => `---\n${fields}\n---\n${body}`;
const files = (snapshot: ImportSnapshot, entries: readonly (readonly [string, string])[]) =>
  snapshotMemoryImportFiles(
    snapshot,
    entries.map(([selector, text]) => ({
      selector,
      text,
      byteCount: new TextEncoder().encode(text).length,
    })),
  );
const candidate = (rows: readonly ImportParsedItem[]) => {
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, "candidate");
  if (row.kind !== "candidate") throw new Error("Expected a candidate");
  return row.candidate;
};
const fixtureTest = (
  name: string,
  test: (snapshot: ImportSnapshot) => Effect.Effect<void, M.MemoryImportRpcError>,
) =>
  it.effect(name, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
        yield* test(fixture.snapshot);
      }),
    ),
  );
const expectIssue = (snapshot: ImportSnapshot, issue: M.MemoryImportIssue) =>
  Effect.match(parseClaudeMemory(snapshot), {
    onSuccess: () => assert.fail("Expected a typed import refusal"),
    onFailure: (error) => {
      assert.instanceOf(error, M.MemoryImportRpcError);
      assert.equal(error.issue, issue);
      assert.deepEqual(JSON.parse(JSON.stringify(error)), { _tag: "MemoryImportRpcError", issue });
    },
  });

describe("ClaudeMemoryImporter", () => {
  it.effect.each(["claude-topic-v1", "claude-topic-metadata-v1"] as const)(
    "extracts the fixed %s fixture",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          assert.equal(
            fixture.snapshot.parserVersion,
            MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS[profile],
          );
          const rows = yield* parseClaudeMemory(fixture.snapshot);
          const item = candidate(rows);
          assert.equal(item.sourceItemKey, "fixture.md#body");
          assert.equal(item.title, "Fixture guidance");
          assert.deepEqual(item.payload.evidence, []);
          assert.deepEqual(item.payload.derivedFromMemoryRevisions, []);
          assert.deepEqual(yield* decodePayload(item.payload), item.payload);
          assert.equal(item.byteCount, new TextEncoder().encode(item.payload.text).length);
          assert.match(item.contentFingerprint, /^[a-f0-9]{64}$/);
          assert.match(item.sourceFingerprint, /^[a-f0-9]{64}$/);
          assert.notInclude(JSON.stringify(item), "synthetic-session");
          assert.deepEqual(yield* parseClaudeMemory(fixture.snapshot), rows);
        }),
      ),
  );

  fixtureTest("supports exactly the four direct types", (snapshot) =>
    Effect.gen(function* () {
      for (const type of ["user", "feedback", "project", "reference"]) {
        candidate(
          yield* parseClaudeMemory(
            files(snapshot, [
              ["topic.md", topic("A fact.", `name: Guidance\ndescription: Topic\ntype: ${type}`)],
            ]),
          ),
        );
      }
    }),
  );

  fixtureTest(
    "canonical body, metadata, version and path have distinct fingerprint roles",
    (snapshot) =>
      Effect.gen(function* () {
        const parse = (text: string, selector = "topic.md", base = snapshot) =>
          Effect.map(parseClaudeMemory(files(base, [[selector, text]])), candidate);
        const a = yield* parse(topic("  Cafe\u0301\r\nKeep case.  "));
        const canonical = yield* parse(topic("Café\nKeep case."));
        assert.deepEqual(a, canonical);
        assert.equal(a.payload.text, "Café\nKeep case.");
        const changed = yield* parse(topic("Changed content."));
        assert.equal(changed.sourceItemKey, a.sourceItemKey);
        assert.notEqual(changed.sourceFingerprint, a.sourceFingerprint);
        assert.notEqual(changed.contentFingerprint, a.contentFingerprint);
        const title = yield* parse(
          topic("Café\nKeep case.", "name: Other\ndescription: A synthetic topic\ntype: project"),
        );
        assert.equal(title.sourceItemKey, a.sourceItemKey);
        assert.equal(title.contentFingerprint, a.contentFingerprint);
        assert.notEqual(title.sourceFingerprint, a.sourceFingerprint);
        const renamed = yield* parse(topic("Café\nKeep case."), "renamed.md");
        assert.notEqual(renamed.sourceItemKey, a.sourceItemKey);
        assert.equal(renamed.sourceFingerprint, a.sourceFingerprint);
        assert.equal(renamed.contentFingerprint, a.contentFingerprint);
        const version = yield* parse(topic("Café\nKeep case."), "topic.md", {
          ...snapshot,
          parserVersion: "future-grammar",
        });
        assert.equal(version.sourceItemKey, a.sourceItemKey);
        assert.equal(version.contentFingerprint, a.contentFingerprint);
        assert.notEqual(version.sourceFingerprint, a.sourceFingerprint);
        const relocated = yield* parse(topic("Café\nKeep case."), "topic.md", {
          ...snapshot,
          sourceLocator: "another/opaque",
          slot: { ...snapshot.slot, selection: "another-opaque" },
        });
        assert.deepEqual(relocated, a);
      }),
  );

  fixtureTest(
    "metadata profile agrees with direct type and ignores foreign session identity",
    (snapshot) =>
      Effect.gen(function* () {
        const base = { ...snapshot, profile: "claude-topic-metadata-v1" };
        const text = (session: string) =>
          topic(
            "Safe body.",
            `name: Topic\ndescription: Safe\ntype: project\nmetadata:\n  type: project\n  node_type: memory\n  originSessionId: ${session}`,
          );
        const a = candidate(yield* parseClaudeMemory(files(base, [["topic.md", text("first")]])));
        const b = candidate(yield* parseClaudeMemory(files(base, [["topic.md", text("second")]])));
        assert.deepEqual(a, b);
        assert.notInclude(JSON.stringify(a), "first");
      }),
  );

  fixtureTest(
    "excludes navigation, nested topics, summary/raw and non-Markdown without following links",
    (snapshot) =>
      Effect.gen(function* () {
        const rows = yield* parseClaudeMemory(
          files(snapshot, [
            ["MEMORY.md", "[topic](../../outside.md)\nrollout_path: outside.jsonl"],
            ["CLAUDE.md", topic()],
            ["nested/topic.md", topic()],
            ["episodes/topic.md", topic()],
            ["agent-memory/topic.md", topic()],
            ["rules/a.md", topic()],
            ["memory_summary.md", topic()],
            ["raw_memories.md", topic()],
            ["session.jsonl", "{}"],
            ["topic.md", topic("[Reference](../../outside.md)\nrollout_path: outside.jsonl")],
          ]),
        );
        assert.equal(
          candidate(rows).payload.text,
          "[Reference](../../outside.md)\nrollout_path: outside.jsonl",
        );
      }),
  );

  fixtureTest(
    "malformed/unsupported headers reject only the item with value-free rows",
    (snapshot) =>
      Effect.gen(function* () {
        const bad = [
          "Plain arbitrary Markdown",
          topic(""),
          topic("body", "name: Title\ndescription: Safe\ntype: unknown"),
          topic("body", "name: First\nname: Second\ndescription: Safe\ntype: user"),
          topic("body", "name: &title Title\ndescription: Safe\ntype: user"),
          topic("body", "name: !!str Title\ndescription: Safe\ntype: user"),
          topic("body", "name: [Title]\ndescription: Safe\ntype: user"),
          topic("body", "name: Title\ndescription: {a: b}\ntype: user"),
          topic("body", "name: Title\ndescription: Safe\ntype: user\nextra: value"),
          topic("body", "name: Title\ndescription: Safe\ntype: user\nmetadata:\n  type: user"),
          topic("body", "name: Title\ntype: user"),
          topic("body", "name: 123\ndescription: Safe\ntype: user"),
          topic("body", "name: *missing\ndescription: Safe\ntype: user"),
        ];
        for (const text of bad) {
          const rows = yield* parseClaudeMemory(
            files(snapshot, [
              ["bad.md", text],
              ["good.md", topic()],
            ]),
          );
          assert.deepEqual(rows[0], {
            kind: "rejected",
            sourceItemKey: "bad.md#body",
            byteCount: new TextEncoder().encode(text).length,
            issue: "unsupported_format",
          });
          assert.equal(rows[1]!.kind, "candidate");
        }
        for (const metadata of [
          "type: project\n  type: user",
          "type: feedback",
          "type: project\n  extra: value",
          "type: project\n  node_type: {a: b}",
          "node_type: memory",
        ]) {
          const text = topic(
            "body",
            `name: Title\ndescription: Safe\ntype: project\nmetadata:\n  ${metadata}`,
          );
          const rows = yield* parseClaudeMemory(
            files({ ...snapshot, profile: "claude-topic-metadata-v1" }, [["bad.md", text]]),
          );
          assert.equal(rows[0]!.kind, "rejected");
        }
      }),
  );

  fixtureTest(
    "secret raw headers, decoded titles, selectors and locators fail the whole snapshot",
    (snapshot) =>
      Effect.gen(function* () {
        const synthetic = "sk-" + "a".repeat(24);
        const bad = [
          files(snapshot, [
            ["good.md", topic()],
            ["bad.md", topic("Safe body.", `name: Topic\ndescription: ${synthetic}\ntype: user`)],
          ]),
          files(snapshot, [[`${synthetic}.md`, topic()]]),
          { ...snapshot, sourceLocator: synthetic },
          files(snapshot, [["bad.md", topic(synthetic)]]),
          files(snapshot, [
            [
              "bad.md",
              topic(
                "Safe body.",
                `name: "sk-\\u0061${"a".repeat(23)}"\ndescription: Safe\ntype: user`,
              ),
            ],
          ]),
        ];
        for (const input of bad) yield* expectIssue(input, "secret_detected");
      }),
  );

  for (const field of ["node_type", "originSessionId"] as const) {
    fixtureTest(`decoded secret ${field} fails before discarding foreign metadata`, (snapshot) =>
      Effect.gen(function* () {
        const text = topic(
          "Safe body.",
          `name: Topic\ndescription: Safe\nmetadata:\n  type: project\n  ${field}: "sk-\\u0061${"a".repeat(23)}"`,
        );
        yield* expectIssue(
          files({ ...snapshot, profile: "claude-topic-metadata-v1" }, [
            [
              "good.md",
              topic("Safe body.", "name: Good\ndescription: Safe\nmetadata:\n  type: project"),
            ],
            ["bad.md", text],
          ]),
          "secret_detected",
        );
      }),
    );
  }

  for (const invalid of ["empty body", "empty description"] as const) {
    fixtureTest(`decoded secret name fails before rejecting ${invalid}`, (snapshot) =>
      Effect.gen(function* () {
        for (const profile of ["claude-topic-v1", "claude-topic-metadata-v1"] as const) {
          const type =
            profile === "claude-topic-v1" ? "type: project" : "metadata:\n  type: project";
          const text = topic(
            invalid === "empty body" ? "" : "Safe body.",
            `name: "sk-\\u0061${"a".repeat(23)}"\ndescription: ${invalid === "empty description" ? '""' : "Safe"}\n${type}`,
          );
          yield* expectIssue(
            files({ ...snapshot, profile }, [
              ["good.md", topic("Safe body.", `name: Good\ndescription: Safe\n${type}`)],
              ["bad.md", text],
            ]),
            "secret_detected",
          );
        }
      }),
    );
  }

  fixtureTest("rejects unsafe/ambiguous selectors before emitting any row", (snapshot) =>
    Effect.gen(function* () {
      for (const selector of [
        "../bad.md",
        "/bad.md",
        "a/../bad.md",
        "a//bad.md",
        "./bad.md",
        "a\\bad.md",
        "bad\0.md",
        "C:bad.md",
        "bad.md#body",
        " bad.md",
      ]) {
        yield* expectIssue(
          files(snapshot, [
            ["good.md", topic()],
            [selector, topic()],
          ]),
          "path_rejected",
        );
      }
      yield* expectIssue(
        files(snapshot, [
          ["same.md", topic()],
          ["same.md", topic()],
        ]),
        "path_rejected",
      );
    }),
  );

  fixtureTest(
    "defends string integrity and declared bytes without confusing valid replacement characters",
    (snapshot) =>
      Effect.gen(function* () {
        yield* expectIssue(files(snapshot, [["bad.md", topic("bad\ud800")]]), "invalid_utf8");
        yield* expectIssue(files(snapshot, [["bad\ud800.md", topic()]]), "invalid_utf8");
        yield* expectIssue(files(snapshot, [["bad.md", topic("bad\0")]]), "unsupported_format");
        const input = files(snapshot, [["topic.md", topic()]]);
        yield* expectIssue(
          snapshotMemoryImportFiles(
            input,
            input.files.map((file) => ({ ...file, byteCount: file.byteCount + 1 })),
          ),
          "source_changed",
        );
        assert.equal(
          candidate(
            yield* parseClaudeMemory(files(snapshot, [["valid.md", topic("Valid � glyph.")]])),
          ).payload.text,
          "Valid � glyph.",
        );
        yield* expectIssue({ ...snapshot, profile: "unknown" }, "unsupported_format");
        yield* expectIssue({ ...snapshot, format: "codex" }, "unsupported_format");
      }),
  );

  fixtureTest(
    "body/title and source-file byte boundaries accept equality and reject +1",
    (snapshot) =>
      Effect.gen(function* () {
        for (const [body, accepted] of [
          ["가".repeat(5461) + "x", true],
          ["가".repeat(5461) + "xy", false],
        ] as const) {
          const rows = yield* parseClaudeMemory(files(snapshot, [["topic.md", topic(body)]]));
          assert.equal(rows[0]!.kind, accepted ? "candidate" : "rejected");
          if (accepted) assert.equal(candidate(rows).byteCount, M.MEMORY_BODY_MAX_UTF8_BYTES);
          else
            assert.deepEqual(rows[0], {
              kind: "rejected",
              sourceItemKey: "topic.md#body",
              byteCount: new TextEncoder().encode(topic(body)).length,
              issue: "limit_exceeded",
            });
        }
        for (const n of [256, 257]) {
          const rows = yield* parseClaudeMemory(
            files(snapshot, [
              ["topic.md", topic("body", `name: ${"😀".repeat(n)}\ndescription: Safe\ntype: user`)],
            ]),
          );
          assert.equal(rows[0]!.kind, n === 256 ? "candidate" : "rejected");
        }
        const prefix = "---\nname: Topic\ndescription: ";
        const suffix = "\ntype: user\n---\nbody";
        const exact = prefix + "x".repeat(256 * 1024 - prefix.length - suffix.length) + suffix;
        candidate(yield* parseClaudeMemory(files(snapshot, [["topic.md", exact]])));
        yield* expectIssue(files(snapshot, [["topic.md", exact + "x"]]), "limit_exceeded");
      }),
  );

  fixtureTest(
    "key, aggregate and candidate count boundaries fail without partial enumeration",
    (snapshot) =>
      Effect.gen(function* () {
        candidate(yield* parseClaudeMemory(files(snapshot, [["x".repeat(504) + ".md", topic()]])));
        yield* expectIssue(files(snapshot, [["x".repeat(505) + ".md", topic()]]), "limit_exceeded");
        const entries = Array.from({ length: 128 }, (_, n) => [`topic-${n}.md`, topic()] as const);
        assert.equal((yield* parseClaudeMemory(files(snapshot, entries))).length, 128);
        yield* expectIssue(
          files(snapshot, [...entries, ["another.md", topic()]]),
          "limit_exceeded",
        );
        const excludedFiles = Array.from(
          { length: 32 },
          (_, n) => [`nested/${n}.md`, "x".repeat(256 * 1024)] as const,
        );
        assert.deepEqual(yield* parseClaudeMemory(files(snapshot, excludedFiles)), []);
        yield* expectIssue(
          files(snapshot, [...excludedFiles, ["nested/extra.md", "x"]]),
          "limit_exceeded",
        );
      }),
  );
});
