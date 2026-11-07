// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk fixture uses Node directly, without application services.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk fixture uses Node directly, without application services.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { acquireMemoryImportReader } from "./MemoryImportReader.ts";
import { parseClaudeMemory } from "./ClaudeMemoryImporter.ts";
import {
  buildMemoryImportFixture,
  type MemoryImportFixture,
} from "./MemoryImportFixtures.fixture.ts";

// Runs on Windows CI too: Codex and Claude reads need no Git executable.
const snapshot = (fixture: MemoryImportFixture) =>
  Effect.gen(function* () {
    const reader = yield* acquireMemoryImportReader({
      stateDir: fixture.stateDir,
      roots: [
        { format: fixture.snapshot.format, rootSlot: "fixture-root", path: fixture.trustedRoot },
      ],
    });
    const snapshot = yield* reader.read({ slot: fixture.snapshot.slot });
    assert.deepEqual(
      NodeFS.readdirSync(NodePath.join(fixture.stateDir, "memory-import", "snapshots")),
      [],
    );
    return snapshot;
  });
const read = (fixture: MemoryImportFixture) =>
  Effect.map(snapshot(fixture), (value) => value.files.map((file) => file.selector));
const fill = (root: string, folder: string, count: number) => {
  const path = NodePath.join(root, ...folder.split("/"));
  NodeFS.mkdirSync(path, { recursive: true });
  for (let i = 0; i < count; i++) NodeFS.writeFileSync(NodePath.join(path, `${i}.md`), "");
};

describe("MemoryImportReader on Windows sources", () => {
  it.effect("a Claude metadata topic saved with a byte order mark keeps its profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("claude-topic-metadata-v1");
        const path = NodePath.join(fixture.sourceRoot, "fixture.md");
        NodeFS.writeFileSync(path, `\uFEFF${NodeFS.readFileSync(path, "utf8")}`);
        const value = yield* snapshot(fixture);
        assert.equal(value.profile, "claude-topic-metadata-v1");
        const rows = yield* parseClaudeMemory(value);
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["candidate"],
        );
      }),
    ),
  );

  it.effect("imports a Codex store beside its rollout summaries, skills and Git history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        // Codex writes these beside MEMORY.md; together they exceed the 512-entry budget.
        for (const folder of ["rollout_summaries", "skills/review", ".git/objects/ab"])
          fill(fixture.sourceRoot, folder, 300);
        assert.deepEqual(yield* read(fixture), ["MEMORY.md"]);
      }),
    ),
  );

  it.effect("imports Codex ad-hoc notes beside a large rollout summary folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
        fill(fixture.sourceRoot, "rollout_summaries", 600);
        assert.deepEqual(yield* read(fixture), ["extensions/ad_hoc/notes/2026-10-13-fixture.md"]);
      }),
    ),
  );

  it.effect.each(["codex-handbook-v1", "claude-topic-v1"] as const)(
    "does not traverse excluded %s directories, however deep",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          fill(fixture.sourceRoot, Array.from({ length: 12 }, () => "nested").join("/"), 1);
          const files = yield* read(fixture);
          assert.deepEqual(files, [profile === "claude-topic-v1" ? "fixture.md" : "MEMORY.md"]);
        }),
      ),
  );
});
