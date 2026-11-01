import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Notes from "./NotesService.ts";
import { parseNote, serializeNote } from "./frontmatter.ts";

const linked = { threadId: ThreadId.make("thread-1"), host: null, lastResult: null };
import { notesLayer as layer, racing } from "./NotesTestkit.ts";

it.effect("uses the first body line as title and excludes it from the preview", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const note = yield* notes.write(
      {
        path: "filename.md",
        body: "\n- [x] First task\n\n> More   context\n```ts\ncode\n```\n",
        baseRevision: null,
      },
      "user",
    );
    assert.strictEqual(note.title, "First task");
    assert.strictEqual(note.preview, "More context code");
    const heading = yield* notes.write(
      { path: "heading.md", body: "Intro\n# Heading\n- Detail\n", baseRevision: null },
      "user",
    );
    assert.strictEqual(heading.title, "Heading");
    assert.strictEqual(heading.preview, "Intro Detail");
  }).pipe(Effect.provide(layer())),
);

it("round trips pinned and related while preserving unknown frontmatter", () => {
  const parsed = parseNote(
    "---\ncustom: keep\npinned: true\nrelated: [local, 'remote@user@host']\n---\nBody\n",
  );
  assert.isTrue(parsed.pinned);
  assert.deepStrictEqual(parsed.related, [
    { threadId: ThreadId.make("local"), host: null },
    { threadId: ThreadId.make("remote@user"), host: "host" },
  ]);
  const roundTrip = parseNote(serializeNote(parsed));
  assert.isTrue(roundTrip.pinned);
  assert.deepStrictEqual(roundTrip.related, parsed.related);
  const cleared = serializeNote({ ...parsed, pinned: false, related: [] });
  assert.notInclude(cleared, "pinned:");
  assert.notInclude(cleared, "related:");
  assert.include(cleared, "custom: keep");
  assert.isFalse(parseNote(cleared).pinned);
  assert.deepStrictEqual(parseNote(cleared).related, []);
});

it.effect("pinned survives body writes and moves and updates publish summaries", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write(
      { path: "a.md", body: "# A\nContext", baseRevision: null },
      "agent",
    );
    const changes = yield* notes.subscribeChanges;
    const event = yield* changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
    const pinned = yield* notes.update({ path: initial.path, pinned: true });
    assert.strictEqual(pinned.updatedBy, "agent");
    const received = yield* Fiber.join(event);
    assert.strictEqual(received[0]?.type, "upserted");
    if (received[0]?.type === "upserted") {
      assert.isTrue(received[0].note.pinned);
      assert.strictEqual(received[0].note.preview, "Context");
      assert.deepStrictEqual(received[0].note.related, []);
    }
    const saved = yield* notes.write(
      { path: pinned.path, body: "new body", baseRevision: pinned.revision },
      "user",
    );
    assert.isTrue(saved.pinned);
    const moved = yield* notes.move(
      { from: saved.path, to: "moved.md", baseRevision: saved.revision },
      "agent",
    );
    assert.isTrue(moved.pinned);
    const unpinned = yield* notes.update({ path: moved.path, pinned: false });
    assert.isFalse(unpinned.pinned);
    assert.strictEqual(
      (yield* notes.update({ path: moved.path, pinned: false })).revision,
      unpinned.revision,
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("header updates re-read a concurrently edited body", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* notes.write({ path: "a.md", body: "before", baseRevision: null }, "user");
    external.arm(
      fs
        .writeFileString(
          `${notesDir}/a.md`,
          "---\nstatus: doing\nupdatedBy: agent\ncustom: keep\n---\nConcurrent body\n",
        )
        .pipe(Effect.orDie),
    );
    const updated = yield* notes.update({ path: "a.md", pinned: true });
    assert.strictEqual(updated.body, "Concurrent body\n");
    assert.strictEqual(updated.status, "doing");
    assert.strictEqual(updated.updatedBy, "agent");
    assert.isTrue(updated.pinned);
    assert.include(yield* fs.readFileString(`${notesDir}/a.md`), "custom: keep");
  }).pipe(Effect.provide(external.layer));
});

it.effect("an update queued during a body write preserves the completed body", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const initial = yield* notes.write(
        { path: "a.md", body: "before", baseRevision: null },
        "user",
      );
      hold = true;
      const writer = yield* notes
        .write({ path: initial.path, body: "Latest body", baseRevision: initial.revision }, "agent")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const update = yield* notes
        .update({ path: initial.path, pinned: true })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      const updated = yield* Fiber.join(update);
      assert.strictEqual(updated.body, "Latest body");
      assert.strictEqual(updated.updatedBy, "agent");
      assert.isTrue(updated.pinned);
    }).pipe(
      Effect.provide(
        layer(undefined, undefined, (fs) => ({
          ...fs,
          makeTempDirectoryScoped: (options) =>
            Effect.gen(function* () {
              if (hold && options?.prefix === ".note-") {
                hold = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* fs.makeTempDirectoryScoped(options);
            }),
        })),
      ),
    );
  }),
);

it.effect(
  "relate and unrelate are idempotent references that never change status or workers",
  () => {
    let writes = 0;
    return Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const reference = { threadId: ThreadId.make("reference"), host: "host" };
      yield* notes.write({ path: "a.md", body: "task", baseRevision: null }, "user");
      const initial = yield* notes.link("a.md", linked);
      const related = yield* notes.update({ path: initial.path, relate: reference });
      assert.deepStrictEqual(related.related, [reference]);
      assert.deepStrictEqual(related.threads, initial.threads);
      assert.strictEqual(related.status, initial.status);
      assert.strictEqual(related.updatedBy, initial.updatedBy);
      const afterRelate = writes;
      assert.strictEqual(
        (yield* notes.update({ path: initial.path, relate: reference })).revision,
        related.revision,
      );
      assert.strictEqual(writes, afterRelate);
      assert.deepStrictEqual(yield* notes.linked(reference.threadId, reference.host), []);
      assert.strictEqual((yield* notes.linked(linked.threadId, linked.host)).length, 1);
      const removed = yield* notes.update({ path: initial.path, unrelate: reference });
      assert.deepStrictEqual(removed.related, []);
      assert.deepStrictEqual(removed.threads, initial.threads);
      assert.strictEqual(removed.status, initial.status);
      assert.strictEqual(
        (yield* notes.update({ path: initial.path, unrelate: reference })).revision,
        removed.revision,
      );
      const workerRef = { threadId: linked.threadId, host: linked.host };
      assert.strictEqual(
        (yield* notes.update({ path: initial.path, relate: workerRef })).revision,
        removed.revision,
      );
    }).pipe(
      Effect.provide(
        layer(undefined, undefined, (fs) => ({
          ...fs,
          makeTempDirectoryScoped: (options) => {
            if (options?.prefix === ".note-") writes++;
            return fs.makeTempDirectoryScoped(options);
          },
        })),
      ),
    );
  },
);

it.effect("rejects unknown local reference threads without changing the note", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write({ path: "a.md", body: "keep", baseRevision: null }, "user");
    const failure = yield* notes
      .update({
        path: initial.path,
        pinned: true,
        relate: { threadId: ThreadId.make("missing"), host: null },
      })
      .pipe(Effect.flip);
    assert.strictEqual(failure.reason, "not_found");
    assert.strictEqual((yield* notes.read({ path: initial.path })).revision, initial.revision);
  }).pipe(Effect.provide(layer())),
);

it.effect("bounds previews without splitting surrogate pairs", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const note = yield* notes.write(
      { path: "a.md", body: `# Title\n${"x".repeat(138)}😀more`, baseRevision: null },
      "user",
    );
    assert.strictEqual(note.preview, `${"x".repeat(138)}…`);
    const empty = yield* notes.write({ path: "empty.md", body: "\n", baseRevision: null }, "user");
    assert.strictEqual(empty.title, "empty");
    assert.strictEqual(empty.preview, "");
    assert.isFalse(empty.pinned);
    assert.deepStrictEqual(empty.related, []);
  }).pipe(Effect.provide(layer())),
);

it.effect("accepts a local reference when the environment has that thread", () => {
  const threadId = ThreadId.make("local-reference");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const now = DateTime.makeUnsafe("2026-10-23T00:00:00.000Z");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Reference",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    sideChatOf: null,
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "a.md", body: "Keep", baseRevision: null }, "user");
    const reference = { threadId, host: null };
    const updated = yield* notes.update({ path: "a.md", relate: reference });
    assert.deepStrictEqual(updated.related, [reference]);
    assert.deepStrictEqual(updated.threads, []);
    assert.strictEqual(updated.status, "idea");
    assert.deepStrictEqual(yield* notes.linked(threadId, null), []);
    assert.strictEqual(
      (yield* notes.update({ path: "a.md", relate: reference })).revision,
      updated.revision,
    );
  }).pipe(
    Effect.provide(
      layer(undefined, undefined, undefined, (id) => {
        assert.strictEqual(id, threadId);
        return Effect.succeed(thread);
      }),
    ),
  );
});
