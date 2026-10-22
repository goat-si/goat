import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { ASIDE_SEMANTIC_PROFILE, parseAsideMemory } from "./AsideMemoryImporter.ts";
import type { ImportParsedItem, ImportSnapshot, ImportSourceFile } from "./MemoryImportTypes.ts";

const FENCE = "```";
const bytes = (text: string) => new TextEncoder().encode(text).length;
const page = (
  current: string,
  front = "title: Synthetic tools\nhost: example.test\naliases: [kit]",
) =>
  `---\n${front}\nupdated: 2026-10-15\n---\n# Synthetic tools\n\n## Current\n\n${current}\n\n## History\n\n- 2026-10-01: an old observation.\n`;
const file = (selector: string, text: string): ImportSourceFile => ({
  selector,
  text,
  byteCount: bytes(text),
});
const snapshot = (
  files: readonly ImportSourceFile[] | Record<string, string>,
  directory = "agent",
): ImportSnapshot => ({
  slot: { format: "aside", rootSlot: "synthetic", selection: `slot-a:${directory}` },
  format: "aside",
  profile: ASIDE_SEMANTIC_PROFILE,
  parserVersion: ASIDE_SEMANTIC_PROFILE,
  sourceLocator: `aside/synthetic/slot-a:${directory}`,
  snapshotDigest: "0".repeat(64),
  files: Array.isArray(files)
    ? files
    : Object.entries(files).map(([selector, text]) => file(selector, text)),
});
const candidates = (rows: readonly ImportParsedItem[]) =>
  rows.flatMap((row) => (row.kind === "candidate" ? [row.candidate] : []));
const rejected = (rows: readonly ImportParsedItem[]) =>
  rows.flatMap((row) => (row.kind === "rejected" ? [row] : []));

describe("Aside semantic page parser", () => {
  it.effect("splits only the leading Current by H3 into stable path keys", () =>
    Effect.gen(function* () {
      const text = page(
        "Prefer small commits.\n\n### Git\n\nRebase before pushing.\n\n### Shell\n\nUse rg first.",
      );
      const rows = yield* parseAsideMemory(snapshot({ "tools.md": text }));
      assert.deepEqual(
        rows.map((row) =>
          row.kind === "candidate" ? row.candidate.sourceItemKey : row.sourceItemKey,
        ),
        ["agent/tools.md#current", "agent/tools.md#current:Git", "agent/tools.md#current:Shell"],
      );
      const [intro, git] = candidates(rows);
      assert.equal(intro!.title, "Synthetic tools");
      assert.equal(intro!.payload.text, "Synthetic tools\n\nPrefer small commits.");
      assert.equal(git!.title, "Synthetic tools — Git");
      assert.equal(git!.payload.text, "Synthetic tools — Git\n\nRebase before pushing.");
      assert.deepEqual(git!.payload.evidence, []);
      assert.isUndefined(git!.requiresProject);
      assert.notInclude(JSON.stringify(rows), "old observation");
      assert.deepEqual(yield* parseAsideMemory(snapshot({ "tools.md": text })), rows);
      const whole = candidates(
        yield* parseAsideMemory(snapshot({ "plain.md": page("One statement.") })),
      );
      assert.deepEqual(
        whole.map((c) => c.sourceItemKey),
        ["agent/plain.md#current"],
      );
    }),
  );

  it.effect("treats headings inside code fences as text", () =>
    Effect.gen(function* () {
      const span = page(FENCE + "inline" + FENCE + " span\n\n### After span\n\nB.");
      assert.deepEqual(
        candidates(yield* parseAsideMemory(snapshot({ "span.md": span }))).map(
          (c) => c.sourceItemKey,
        ),
        ["agent/span.md#current", "agent/span.md#current:After span"],
      );
      const text = [
        "---",
        "title: Fenced",
        "---",
        FENCE + "md",
        "## Current",
        FENCE,
        "",
        "## Current",
        "",
        "Before.",
        "",
        "~~~~",
        "## History",
        "### Not a split",
        "~~~~",
        "",
        "After.",
        "",
        "## History",
        "",
      ].join("\n");
      const [item, ...rest] = candidates(yield* parseAsideMemory(snapshot({ "fenced.md": text })));
      assert.lengthOf(rest, 0);
      assert.equal(item!.sourceItemKey, "agent/fenced.md#current");
      assert.include(item!.payload.text, "### Not a split");
      assert.include(item!.payload.text, "After.");
    }),
  );

  it.effect.each([
    ["no frontmatter", "## Current\n\nText.\n"],
    ["no Current", "---\ntitle: X\n---\n## History\n\nText.\n"],
    ["Current is not the first H2", "---\ntitle: X\n---\n## Notes\n\nA.\n\n## Current\n\nB.\n"],
    ["unexpected H2 inside Current", "---\ntitle: X\n---\n## Current\n\nA.\n\n## Notes\n\nB.\n"],
    [
      "repeated Current",
      "---\ntitle: X\n---\n## Current\n\nA.\n\n## History\n\nB.\n\n## Current\n\nC.\n",
    ],
    [
      "repeated History",
      "---\ntitle: X\n---\n## Current\n\nA.\n\n## History\n\nB.\n\n## History\n\nC.\n",
    ],
    ["duplicate H3", "---\ntitle: X\n---\n## Current\n\n### Same\n\nA.\n\n###  Same \n\nB.\n"],
    ["unclosed fence", "---\ntitle: X\n---\n## Current\n\n```\nA.\n"],
    ["empty Current", "---\ntitle: X\n---\n## Current\n\n## History\n\nB.\n"],
    ["structured title", "---\ntitle: { a: 1 }\n---\n## Current\n\nA.\n"],
    ["nested unknown field", "---\ntitle: X\nmeta:\n  a: 1\n---\n## Current\n\nA.\n"],
    [
      "Setext History boundary",
      "---\ntitle: X\n---\n## Current\n\nKeep.\n\nHistory\n-------\n\nObsolete.\n",
    ],
    ["Setext Current", "---\ntitle: X\n---\nCurrent\n=======\n\nA.\n"],
    ["H1 inside Current", "---\ntitle: X\n---\n## Current\n\nA.\n\n# Archive\n\nB.\n"],
  ] as const)("refuses %s per file while siblings import", ([, text]) =>
    Effect.gen(function* () {
      const rows = yield* parseAsideMemory(snapshot({ "bad.md": text, "good.md": page("Fine.") }));
      assert.deepEqual(rejected(rows), [
        {
          kind: "rejected",
          sourceItemKey: "agent/bad.md#current",
          byteCount: bytes(text),
          issue: "unsupported_format",
        },
      ]);
      assert.deepEqual(
        candidates(rows).map((c) => c.sourceItemKey),
        ["agent/good.md#current"],
      );
    }),
  );

  it.effect("reports oversized sections and reader-refused pages without truncating", () =>
    Effect.gen(function* () {
      const large = "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES);
      const rows = yield* parseAsideMemory(
        snapshot([
          file("big.md", page(`### Small\n\nkept\n\n### Large\n\n${large}`)),
          { selector: "huge.md", text: "", byteCount: 323208, issue: "limit_exceeded" },
        ]),
      );
      assert.deepEqual(
        candidates(rows).map((c) => c.sourceItemKey),
        ["agent/big.md#current:Small"],
      );
      const refused = rejected(rows);
      assert.deepEqual(
        refused.map((r) => [r.sourceItemKey, r.issue]),
        [
          ["agent/big.md#current:Large", "limit_exceeded"],
          ["agent/huge.md#current", "limit_exceeded"],
        ],
      );
      assert.isAbove(refused[0]!.byteCount, M.MEMORY_BODY_MAX_UTF8_BYTES);
      assert.equal(refused[1]!.byteCount, 323208);
    }),
  );

  it.effect("refuses a preview over the item limit instead of dropping rows", () =>
    Effect.gen(function* () {
      const current = Array.from(
        { length: M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS + 1 },
        (_, n) => `### Item ${n}\n\nbody ${n}`,
      ).join("\n\n");
      const error = yield* parseAsideMemory(snapshot({ "many.md": page(current) })).pipe(
        Effect.flip,
      );
      assert.equal(error.issue, "limit_exceeded");
    }),
  );

  it.effect("marks projects/ rows as needing an explicit project binding", () =>
    Effect.gen(function* () {
      const rows = yield* parseAsideMemory(
        snapshot({ "goat.md": page("Ship it."), "bad.md": "nope" }, "projects"),
      );
      assert.isTrue(
        rows.every((row) =>
          row.kind === "candidate" ? row.candidate.requiresProject : row.requiresProject,
        ),
      );
      assert.equal(candidates(rows)[0]!.sourceItemKey, "projects/goat.md#current");
    }),
  );

  it.effect("keeps the content fingerprint across H3 and title renames", () =>
    Effect.gen(function* () {
      const [before] = candidates(
        yield* parseAsideMemory(snapshot({ "t.md": page("### Git\n\nRebase.") })),
      );
      const [renamed] = candidates(
        yield* parseAsideMemory(snapshot({ "t.md": page("### Git usage\n\nRebase.") })),
      );
      const [retitled] = candidates(
        yield* parseAsideMemory(
          snapshot({ "t.md": page("### Git\n\nRebase.", "title: Other title") }),
        ),
      );
      assert.notEqual(renamed!.sourceItemKey, before!.sourceItemKey);
      assert.equal(renamed!.contentFingerprint, before!.contentFingerprint);
      assert.equal(retitled!.sourceItemKey, before!.sourceItemKey);
      assert.equal(retitled!.contentFingerprint, before!.contentFingerprint);
      assert.notEqual(retitled!.sourceFingerprint, before!.sourceFingerprint);
    }),
  );

  it.effect("refuses snapshots from another format, profile or directory", () =>
    Effect.gen(function* () {
      const base = snapshot({ "t.md": page("A.") });
      for (const input of [
        { ...base, profile: "claude-topic-v1" },
        { ...base, slot: { ...base.slot, selection: "slot-a:episodic" } },
        { ...base, slot: { ...base.slot, selection: "agent" } },
      ]) {
        const error = yield* parseAsideMemory(input).pipe(Effect.flip);
        assert.equal(error.issue, "unsupported_format");
      }
    }),
  );
});
