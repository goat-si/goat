import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseCodexMemory as parseUncheckedCodexMemory } from "./CodexMemoryImporter.ts";
import {
  buildMemoryImportFixture,
  MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";
import type { ImportParsedItem, ImportSnapshot } from "./MemoryImportTypes.ts";

const decodePayload = Schema.decodeUnknownSync(M.MemoryPayload);
// Validate every returned candidate, including mixed candidate/rejection results.
const parseCodexMemory = (snapshot: ImportSnapshot) =>
  Effect.map(parseUncheckedCodexMemory(snapshot), (items) => {
    for (const item of items)
      if (item.kind === "candidate")
        assert.deepEqual(decodePayload(item.candidate.payload), item.candidate.payload);
    return items;
  });
const handbook = (body = "Use focused verification.", title = "Guidance", metadata = "") =>
  `# Task Group: ${title}\nscope: synthetic work\n${metadata}\n## Task 1: Check\n\n### learnings\n${body}`;
const note = "extensions/ad_hoc/notes/note.md";
const files = (snapshot: ImportSnapshot, entries: Readonly<Record<string, string>>) =>
  snapshotMemoryImportFiles(
    snapshot,
    Object.entries(entries).map(([selector, text]) => ({
      selector,
      text,
      byteCount: new TextEncoder().encode(text).length,
    })),
  );
const candidates = (items: readonly ImportParsedItem[]) =>
  items.map((item) => {
    assert.equal(item.kind, "candidate");
    if (item.kind !== "candidate") throw new Error("Expected candidate");
    return item.candidate;
  });
const failure = (snapshot: ImportSnapshot, issue: M.MemoryImportIssue) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(parseCodexMemory(snapshot));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, M.MemoryImportRpcError);
      assert.equal(result.failure.issue, issue);
      assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result.failure))).sort(), [
        "_tag",
        "issue",
      ]);
    }
  });

describe("Codex memory pure profiles", () => {
  it.effect.each(["codex-handbook-v1", "codex-ad-hoc-v1"] as const)(
    "extracts frozen %s fixture and strict payload",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture(profile);
          assert.equal(snapshot.parserVersion, MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS[profile]);
          const [item] = candidates(yield* parseCodexMemory(snapshot));
          assert.ok(item);
          assert.equal(
            item.sourceItemKey,
            profile === "codex-handbook-v1"
              ? "MEMORY.md#task-group:Fixture guidance"
              : "extensions/ad_hoc/notes/2026-10-13-fixture.md#body",
          );
          assert.deepEqual(decodePayload(item.payload), item.payload);
          assert.deepEqual(item.payload.evidence, []);
          assert.deepEqual(item.payload.derivedFromMemoryRevisions, []);
          assert.equal(item.byteCount, new TextEncoder().encode(item.payload.text).length);
          assert.match(item.contentFingerprint, /^[0-9a-f]{64}$/u);
          assert.match(item.sourceFingerprint, /^[0-9a-f]{64}$/u);
          assert.deepEqual(yield* parseCodexMemory(snapshot), [
            { kind: "candidate", candidate: item },
          ]);
        }),
      ),
  );

  it.effect(
    "retains guidance and fenced fake headings, removes only routing/evidence sections",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
          const text = handbook(
            [
              "Useful guidance.",
              "```md",
              "# Task Group: Not a group",
              "scope: literal code",
              "```",
              "~~~",
              "# Task Group: Also code",
              "~~~",
              "### rollout_summary_files",
              "- rollout_summaries/absent.md (rollout_path=/absent/session)",
              "### keywords",
              "- hidden routing",
              "## Reusable knowledge",
              "Keep [link](skills/absent.md) as data.",
            ].join("\n"),
            "Guidance",
            "applies_to: cwd=/synthetic/checkout; reuse_rule=only here",
          );
          const [item] = candidates(
            yield* parseCodexMemory(files(snapshot, { "MEMORY.md": text })),
          );
          assert.equal(
            item!.payload.text,
            [
              "## Task 1: Check",
              "",
              "### learnings",
              "Useful guidance.",
              "```md",
              "# Task Group: Not a group",
              "scope: literal code",
              "```",
              "~~~",
              "# Task Group: Also code",
              "~~~",
              "## Reusable knowledge",
              "Keep [link](skills/absent.md) as data.",
            ].join("\n"),
          );
          assert.equal(item!.title, "Guidance");
        }),
      ),
  );

  it.effect("canonical text preserves case and uses NFC, LF and trim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
        const [a] = candidates(
          yield* parseCodexMemory(files(snapshot, { [note]: "  Cafe\u0301\r\nGuide  " })),
        );
        const [b] = candidates(yield* parseCodexMemory(files(snapshot, { [note]: "Café\nGuide" })));
        assert.deepEqual(a, b);
        assert.equal(a!.payload.text, "Café\nGuide");
        // SHA-256("abc"), independent standard known-answer vector.
        const [known] = candidates(yield* parseCodexMemory(files(snapshot, { [note]: "abc" })));
        assert.equal(
          known!.contentFingerprint,
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        const [upper] = candidates(yield* parseCodexMemory(files(snapshot, { [note]: "ABC" })));
        assert.notEqual(known!.contentFingerprint, upper!.contentFingerprint);
      }),
    ),
  );

  it.effect(
    "edits retain identity, metadata affects source hash, path/title renames create keys",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
          const get = (text: string) =>
            Effect.map(
              parseCodexMemory(files(snapshot, { "MEMORY.md": text })),
              (rows) => candidates(rows)[0]!,
            );
          const a = yield* get(handbook("First"));
          const b = yield* get(handbook("Changed"));
          assert.equal(a.sourceItemKey, b.sourceItemKey);
          assert.notEqual(a.contentFingerprint, b.contentFingerprint);
          assert.notEqual(a.sourceFingerprint, b.sourceFingerprint);
          const routed = yield* get(
            handbook("First", "Guidance", "applies_to: cwd=/synthetic; reuse_rule=only here"),
          );
          assert.equal(a.contentFingerprint, routed.contentFingerprint);
          assert.notEqual(a.sourceFingerprint, routed.sourceFingerprint);
          const renamed = yield* get(handbook("First", "Renamed"));
          assert.notEqual(a.sourceItemKey, renamed.sourceItemKey);
          assert.equal(a.contentFingerprint, renamed.contentFingerprint);
          assert.notEqual(a.sourceFingerprint, renamed.sourceFingerprint);
          const adHoc = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          const [n1] = candidates(
            yield* parseCodexMemory(files(adHoc.snapshot, { [note]: "same" })),
          );
          const [n2] = candidates(
            yield* parseCodexMemory(
              files(adHoc.snapshot, { "extensions/ad_hoc/notes/moved.md": "same" }),
            ),
          );
          assert.notEqual(n1!.sourceItemKey, n2!.sourceItemKey);
          assert.equal(n1!.contentFingerprint, n2!.contentFingerprint);
          assert.equal(n1!.sourceFingerprint, n2!.sourceFingerprint);
        }),
      ),
  );

  it.effect("excludes summary/raw/rollout/skills/nested resources and never falls back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
        const excluded = {
          "memory_summary.md": "v1",
          "raw_memories.md": "raw",
          "rollout_summaries/r.md": "rollout",
          "skills/s/SKILL.md": "skill",
          "sessions/s.jsonl": "{}",
          "nested/MEMORY.md": handbook(),
          "extensions/ad_hoc/resources/x.md": "resource",
          "instructions.md": "instructions",
        };
        assert.deepEqual(yield* parseCodexMemory(files(snapshot, excluded)), []);
        yield* failure(
          files(snapshot, { "MEMORY.md": "# Navigation\n- [topic](nested/topic.md)" }),
          "unsupported_format",
        );
        const adHoc = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
        assert.deepEqual(
          yield* parseCodexMemory(
            files(adHoc.snapshot, {
              ...excluded,
              "MEMORY.md": handbook(),
              "extensions/ad_hoc/notes/nested/a.md": "nested",
              "extensions/ad_hoc/notes/instructions.md": "instructions",
              "extensions/other/notes/a.md": "other",
            }),
          ),
          [],
        );
      }),
    ),
  );

  it.effect.each([
    "../MEMORY.md",
    "/MEMORY.md",
    "a/../MEMORY.md",
    "a\\MEMORY.md",
    "a//b",
    "./MEMORY.md",
    "a\u0000.md",
    "C:/a.md",
  ])("rejects unsafe selector %j without rows", (selector) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
        yield* failure(
          files(snapshot, { "MEMORY.md": handbook(), [selector]: "safe" }),
          "path_rejected",
        );
      }),
    ),
  );

  it.effect(
    "rejects secrets in raw evidence/header/body/selector/locator without returning partial rows",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
          const synthetic = "sk-" + "SYNTHETIC".repeat(4);
          for (const text of [
            handbook("Safe", synthetic),
            handbook(synthetic),
            handbook("Safe", "Guidance", `scope: ${synthetic}`),
            handbook(`### rollout_summary_files\n- ${synthetic}`),
          ]) {
            yield* failure(
              files(snapshot, {
                "MEMORY.md": `${handbook("Safe prefix", "First safe group")}\n${text}`,
              }),
              "secret_detected",
            );
          }
          yield* failure({ ...snapshot, sourceLocator: synthetic }, "secret_detected");
          yield* failure(files(snapshot, { [`${synthetic}.md`]: "safe" }), "secret_detected");
        }),
      ),
  );

  it.effect(
    "rejects duplicate NFC titles, ambiguous scope/routing, unclosed fences and transcript envelopes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
          yield* failure(
            files(snapshot, {
              "MEMORY.md": `${handbook("a", "Café")}\n${handbook("b", "Cafe\u0301")}`,
            }),
            "unsupported_format",
          );
          yield* failure(
            files(snapshot, { "MEMORY.md": handbook("```\nunclosed") }),
            "unsupported_format",
          );
          for (const text of [
            "# Task Group: Missing scope\nUseful",
            handbook("safe", "Guidance", "scope: duplicate"),
            handbook("safe", "Guidance", "applies_to: arbitrary"),
            handbook(
              "safe",
              "Guidance",
              "applies_to: cwd=/x; reuse_rule=x\napplies_to: cwd=/y; reuse_rule=y",
            ),
          ]) {
            const rows = yield* parseCodexMemory(files(snapshot, { "MEMORY.md": text }));
            assert.equal(rows[0]!.kind, "rejected");
            assert.deepEqual(Object.keys(rows[0]!).sort(), [
              "byteCount",
              "issue",
              "kind",
              "sourceItemKey",
            ]);
          }
          const adHoc = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          yield* failure(
            files(adHoc.snapshot, {
              [note]: '{"type":"session_meta","payload":{}}\n{"type":"event_msg"}',
            }),
            "unsupported_format",
          );
          const blank = yield* parseCodexMemory(files(adHoc.snapshot, { [note]: " \n " }));
          assert.deepEqual(blank, [
            {
              kind: "rejected",
              sourceItemKey: `${note}#body`,
              byteCount: 0,
              issue: "unsupported_format",
            },
          ]);
        }),
      ),
  );

  it.effect.each(["safe\u0000text", "bad\ud800", "bad\udc00"])(
    "defends against invalid snapshot text %j",
    (text) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          yield* failure(files(snapshot, { [note]: text }), "invalid_utf8");
        }),
      ),
  );

  it.effect("defends against mismatched bytes, duplicate files and wrong profile/version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
        yield* failure(
          snapshotMemoryImportFiles(snapshot, [{ ...snapshot.files[0]!, byteCount: 0 }]),
          "source_changed",
        );
        yield* failure(
          snapshotMemoryImportFiles(snapshot, [...snapshot.files, ...snapshot.files]),
          "unsupported_format",
        );
        yield* failure({ ...snapshot, profile: "unknown" }, "unsupported_format");
        yield* failure({ ...snapshot, parserVersion: "future" }, "unsupported_format");
        yield* failure({ ...snapshot, format: "claude" }, "unsupported_format");
      }),
    ),
  );

  it.effect.each(["codex-handbook-v1", "codex-ad-hoc-v1"] as const)(
    "encoded payload equality, +1 and JSON escape expansion for %s",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture(profile);
          const isHandbook = profile === "codex-handbook-v1";
          const selector = isHandbook ? "MEMORY.md" : note;
          const sourceItemKey = isHandbook ? "MEMORY.md#task-group:Guidance" : `${note}#body`;
          const input = (text: string) =>
            files(snapshot, {
              [selector]: isHandbook
                ? `# Task Group: Guidance\nscope: synthetic work\n${text}`
                : text,
            });
          const encodedBytes = (text: string) =>
            new TextEncoder().encode(
              JSON.stringify({ text, evidence: [], derivedFromMemoryRevisions: [] }),
            ).length;
          const prefix = "a" + "\u0001".repeat(10_000);
          const at = prefix + "x".repeat(M.MEMORY_PAYLOAD_MAX_UTF8_BYTES - encodedBytes(prefix));
          assert.equal(encodedBytes(at), M.MEMORY_PAYLOAD_MAX_UTF8_BYTES);
          assert.equal(encodedBytes(at + "x"), M.MEMORY_PAYLOAD_MAX_UTF8_BYTES + 1);
          const [accepted] = candidates(yield* parseCodexMemory(input(at)));
          assert.equal(accepted!.payload.text, at);
          for (const text of [at + "x", "a" + "\u0001".repeat(12_000)]) {
            const byteCount = new TextEncoder().encode(text).length;
            assert.ok(byteCount <= M.MEMORY_BODY_MAX_UTF8_BYTES);
            assert.ok(encodedBytes(text) > M.MEMORY_PAYLOAD_MAX_UTF8_BYTES);
            assert.deepEqual(yield* parseCodexMemory(input(text)), [
              { kind: "rejected", sourceItemKey, byteCount, issue: "limit_exceeded" },
            ]);
          }
        }),
      ),
  );

  it.effect("body/title equality and +1 reject entire items without truncation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
        const [at] = candidates(
          yield* parseCodexMemory(
            files(snapshot, { [note]: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES) }),
          ),
        );
        assert.equal(at!.byteCount, M.MEMORY_BODY_MAX_UTF8_BYTES);
        assert.deepEqual(
          yield* parseCodexMemory(
            files(snapshot, { [note]: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES + 1) }),
          ),
          [
            {
              kind: "rejected",
              sourceItemKey: `${note}#body`,
              byteCount: M.MEMORY_BODY_MAX_UTF8_BYTES + 1,
              issue: "limit_exceeded",
            },
          ],
        );
        const hb = yield* buildMemoryImportFixture("codex-handbook-v1");
        assert.equal(
          candidates(
            yield* parseCodexMemory(
              files(hb.snapshot, { "MEMORY.md": handbook("safe", "t".repeat(256)) }),
            ),
          )[0]!.title!.length,
          256,
        );
        const over = yield* parseCodexMemory(
          files(hb.snapshot, { "MEMORY.md": handbook("safe", "t".repeat(257)) }),
        );
        assert.equal(over[0]!.kind, "rejected");
        if (over[0]!.kind === "rejected") assert.equal(over[0]!.issue, "limit_exceeded");
      }),
    ),
  );

  it.effect("NFC title identity, multibyte body/key limits and Markdown JSON data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { snapshot } = yield* buildMemoryImportFixture("codex-handbook-v1");
        const [a] = candidates(
          yield* parseCodexMemory(files(snapshot, { "MEMORY.md": handbook("same", "Cafe\u0301") })),
        );
        const [b] = candidates(
          yield* parseCodexMemory(files(snapshot, { "MEMORY.md": handbook("same", "Café") })),
        );
        assert.deepEqual(a, b);
        const longBody = "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES);
        const oversized = yield* parseCodexMemory(
          files(snapshot, { "MEMORY.md": handbook(longBody) }),
        );
        assert.equal(oversized[0]!.kind, "rejected");
        const adHoc = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
        const text = "é".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES / 2);
        assert.equal(
          candidates(yield* parseCodexMemory(files(adHoc.snapshot, { [note]: text })))[0]!
            .byteCount,
          M.MEMORY_BODY_MAX_UTF8_BYTES,
        );
        const tooLong = yield* parseCodexMemory(files(adHoc.snapshot, { [note]: text + "a" }));
        assert.equal(tooLong[0]!.kind, "rejected");
        const prefix = "extensions/ad_hoc/notes/";
        const keyPath = prefix + "x".repeat(512 - prefix.length - ".md#body".length) + ".md";
        assert.equal(
          candidates(yield* parseCodexMemory(files(adHoc.snapshot, { [keyPath]: "safe" })))[0]!
            .sourceItemKey.length,
          512,
        );
        yield* failure(files(adHoc.snapshot, { [keyPath + ".md"]: "safe" }), "path_rejected");
        const json = 'Use this example:\n```json\n{"setting":true}\n```';
        assert.equal(
          candidates(yield* parseCodexMemory(files(adHoc.snapshot, { [note]: json })))[0]!.payload
            .text,
          json,
        );
      }),
    ),
  );

  it.effect(
    "file/aggregate/candidate ceilings accept equality and fail +1 with no partial success",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          const text = "x".repeat(256 * 1024);
          assert.equal(
            (yield* parseCodexMemory(files(snapshot, { [note]: text })))[0]!.kind,
            "rejected",
          );
          yield* failure(files(snapshot, { [note]: text + "x" }), "limit_exceeded");
          const aggregate = Object.fromEntries(
            Array.from({ length: 32 }, (_, i) => [`extensions/ad_hoc/notes/${i}.md`, text]),
          );
          assert.equal((yield* parseCodexMemory(files(snapshot, aggregate))).length, 32);
          yield* failure(files(snapshot, { ...aggregate, [note]: "x" }), "limit_exceeded");
          const many = Object.fromEntries(
            Array.from({ length: 128 }, (_, i) => [`extensions/ad_hoc/notes/${i}.md`, "safe"]),
          );
          assert.equal((yield* parseCodexMemory(files(snapshot, many))).length, 128);
          yield* failure(files(snapshot, { ...many, [note]: "safe" }), "limit_exceeded");
        }),
      ),
  );
});
