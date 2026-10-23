// @effect-diagnostics-next-line nodeBuiltinImport:off -- tests replace link/copyFile inside the service.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { assert, it } from "@effect/vitest";
import {
  NOTE_TITLE_MAX_LENGTH,
  NoteSummary,
  RunId,
  ThreadId,
  type ThreadResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Notes from "./NotesService.ts";
import { parseNote, serializeNote } from "./frontmatter.ts";

const isSummary = Schema.is(NoteSummary);
const linked = { threadId: ThreadId.make("thread-1"), host: null, lastResult: null };
import { notesLayer as layer, racing } from "./NotesTestkit.ts";

it("round trips unknown frontmatter keys, comments, remote links, and body", () => {
  const source =
    "---\n# Keep this\ncustom:\n  nested: [one, two]\nstatus: doing\nthreads: [local, 'remote@user@host']\nupdatedBy: user\n---\n# Title\n\n- [ ] task\n";
  const parsed = parseNote(source);
  assert.strictEqual(parsed.threads[1]?.threadId, "remote@user");
  assert.strictEqual(parsed.threads[1]?.host, "host");
  const next = serializeNote({ ...parsed, updatedBy: "agent" });
  assert.include(next, "# Keep this");
  assert.include(next, "nested: [ one, two ]");
  assert.strictEqual(parseNote(next).body, parsed.body);
  assert.strictEqual(parseNote(next).updatedBy, "agent");
  assert.deepStrictEqual(parseNote("plain\n").threads, []);
  assert.strictEqual(parseNote("plain\n").status, "idea");
  const empty = parseNote("---\n---\nbody\n");
  assert.strictEqual(empty.body, "body\n");
  assert.strictEqual(parseNote(serializeNote({ ...empty, updatedBy: "user" })).status, "idea");
});

it.effect("CRUD refuses stale writes, preserves external metadata, and emits ordered changes", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const snapshots = yield* Deferred.make<void>();
    const stream = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(snapshots, undefined) : Effect.void,
      ),
      Stream.take(5),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(snapshots);
    const initial = yield* notes.write(
      { path: "project/a.md", body: "# A\n- [ ] task\n", baseRevision: null },
      "user",
    );
    const changed = yield* notes.write(
      { path: initial.path, body: "# A\n- [x] task\n", baseRevision: initial.revision },
      "agent",
    );
    const conflict = yield* notes
      .write({ path: initial.path, body: "stale", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    if (conflict._tag === "NoteConflictError") assert.deepStrictEqual(conflict.current, changed);
    const exists = yield* notes
      .write({ path: initial.path, body: "overwrite", baseRevision: null }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(exists._tag, "NoteError");
    if (exists._tag === "NoteError") assert.strictEqual(exists.reason, "exists");
    const moved = yield* notes.move(
      { from: changed.path, to: "b.md", baseRevision: changed.revision },
      "user",
    );
    assert.strictEqual(moved.updatedBy, "user");
    const events = yield* Fiber.join(stream);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["snapshot", "upserted", "upserted", "upserted", "removed"],
    );
    assert.strictEqual((yield* notes.list({ folder: "project" })).notes.length, 0);
    yield* notes.delete({ path: moved.path, baseRevision: moved.revision });
    assert.strictEqual(
      (yield* notes.read({ path: moved.path }).pipe(Effect.flip)).reason,
      "not_found",
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("serializes concurrent writers so exactly one revision wins", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write(
      { path: "a.md", body: "initial", baseRevision: null },
      "user",
    );
    const results = yield* Effect.all(
      ["left", "right"].map((body) =>
        notes
          .write({ path: initial.path, body, baseRevision: initial.revision }, "agent")
          .pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
    assert.strictEqual(results.filter((result) => result._tag === "Failure").length, 1);
  }).pipe(Effect.provide(layer())),
);

it.effect("reads frontmatter defaults and keeps unknown keys through writes and moves", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* fs.writeFileString(
      `${notesDir}/external.md`,
      "---\ncustom: yes\nthreads: [local]\n---\n# External\n",
    );
    const initial = yield* notes.read({ path: "external.md" });
    assert.strictEqual(initial.status, "idea");
    assert.strictEqual(initial.updatedBy, null);
    const saved = yield* notes.write(
      { path: initial.path, baseRevision: initial.revision, body: "changed\n" },
      "agent",
    );
    yield* notes.move(
      { from: saved.path, to: "folder/moved.md", baseRevision: saved.revision },
      "user",
    );
    assert.include(yield* fs.readFileString(`${notesDir}/folder/moved.md`), "custom: yes");
  }).pipe(Effect.provide(layer())),
);

it.effect("rejects invalid paths, escaping directory/file symlinks and oversized bodies", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { notesDir } = yield* Config.ServerConfig;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "goat-notes-outside-" });
    yield* fs.writeFileString(path.join(outside, "a.md"), "private");
    yield* fs.symlink(outside, path.join(notesDir, "escape"));
    yield* fs.symlink(path.join(outside, "a.md"), path.join(notesDir, "link.md"));
    for (const name of [
      "../a.md",
      "/tmp/a.md",
      ".hidden.md",
      "a/b/c.md",
      "escape/a.md",
      "link.md",
    ]) {
      const error = yield* notes
        .write({ path: name, body: "x", baseRevision: null }, "agent")
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NoteError");
      if (error._tag === "NoteError") assert.strictEqual(error.reason, "invalid_path", name);
    }
    assert.strictEqual(yield* fs.readFileString(path.join(outside, "a.md")), "private");
    const large = yield* notes
      .write({ path: "large.md", body: "한".repeat(400000), baseRevision: null }, "user")
      .pipe(Effect.flip);
    if (large._tag === "NoteError") assert.strictEqual(large.reason, "too_large");
    else assert.fail("Expected too_large");
  }).pipe(Effect.provide(layer())),
);

it.live("recursive watcher observes an external edit and deletion through subscribe", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* fs.makeDirectory(`${notesDir}/project`);
    const subscribed = yield* Deferred.make<void>();
    const changed = yield* Deferred.make<void>();
    const watcher = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot"
          ? Deferred.succeed(subscribed, undefined)
          : event.type === "upserted"
            ? Deferred.succeed(changed, undefined)
            : Effect.void,
      ),
      Stream.filter((event) => event.type !== "snapshot"),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    yield* fs.writeFileString(`${notesDir}/project/task.md`, "# External\n- [x] done\n");
    yield* Deferred.await(changed);
    yield* fs.remove(`${notesDir}/project/task.md`);
    const events = yield* Fiber.join(watcher);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["upserted", "removed"],
    );
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect.each([
  ["running", "succeeded", false],
  ["completed", null, false],
  ["completed", "failed", false],
  ["cancelled", "succeeded", false],
  ["completed", "succeeded", true],
] as const)("done requires completed + succeeded (%s/%s)", ([runStatus, outcome, expected]) =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "a.md", body: "task", baseRevision: null }, "user");
    yield* notes.link("a.md", linked);
    assert.strictEqual(yield* notes.complete("a.md", linked), expected);
    assert.strictEqual((yield* notes.read({ path: "a.md" })).status, expected ? "done" : "doing");
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed({
          runId: RunId.make("run-1"),
          runStatus,
          outcome,
          reportedAt: null,
          pullRequests: [],
          commits: [],
          branch: null,
        }),
      ),
    ),
  ),
);

it.effect("completion rechecks the last link and status under the write lock", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "a.md", body: "task", baseRevision: null }, "user");
    yield* notes.link("a.md", linked);
    const newer = { ...linked, threadId: ThreadId.make("thread-2") };
    yield* notes.link("a.md", newer);
    assert.isFalse(yield* notes.complete("a.md", linked));
    const current = yield* notes.read({ path: "a.md" });
    yield* notes.write(
      { path: current.path, body: current.body, status: "idea", baseRevision: current.revision },
      "user",
    );
    assert.isFalse(yield* notes.complete("a.md", newer));
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed({
          runId: RunId.make("r"),
          runStatus: "completed",
          outcome: "succeeded",
          reportedAt: null,
          pullRequests: [],
          commits: [],
          branch: null,
        } satisfies ThreadResult),
      ),
    ),
  ),
);

it.effect("a completion waiting on a result cannot finish a newly linked worker", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let waiting = false;
    const succeeded: ThreadResult = {
      runId: RunId.make("run"),
      runStatus: "completed",
      outcome: "succeeded",
      reportedAt: null,
      pullRequests: [],
      commits: [],
      branch: null,
    };
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
      yield* notes.link("task.md", linked);
      waiting = true;
      const completion = yield* notes.complete("task.md", linked).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      waiting = false;
      yield* notes.link("task.md", { ...linked, threadId: ThreadId.make("new-worker") });
      yield* Deferred.succeed(release, undefined);
      assert.isFalse(yield* Fiber.join(completion));
      assert.strictEqual((yield* notes.read({ path: "task.md" })).status, "doing");
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.gen(function* () {
            if (waiting) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return succeeded;
          }),
        ),
      ),
    );
  }),
);

it.live("coalesces dirty paths without losing a second file in the same window", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* notes.write({ path: "a.md", body: "before", baseRevision: null }, "user");
    yield* notes.write({ path: "b.md", body: "before", baseRevision: null }, "user");
    const ready = yield* Deferred.make<void>();
    const updates = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type === "upserted"),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* Effect.all(
      [
        fs.writeFileString(`${notesDir}/a.md`, "changed a"),
        fs.writeFileString(`${notesDir}/b.md`, "changed b"),
      ],
      { concurrency: "unbounded" },
    );
    const events = yield* Fiber.join(updates);
    assert.deepStrictEqual(
      events.map((event) => (event.type === "upserted" ? event.note.path : "")).toSorted(),
      ["a.md", "b.md"],
    );
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it("recognizes frontmatter only at byte zero or after a BOM", () => {
  for (const body of [
    "# Keep this heading\n\n---\ncustom: yes\n---\nTail\n",
    "\n---\nstatus: done\n---\nbody\n",
  ]) {
    const parsed = parseNote(body);
    assert.strictEqual(parsed.body, body);
    assert.strictEqual(parsed.metadata, null);
    assert.strictEqual(parseNote(serializeNote(parsed)).body, body);
  }
  assert.strictEqual(parseNote("\uFEFF---\nstatus: doing\n---\nbody").status, "doing");
});

it.effect("rejects case aliases instead of publishing a second note identity", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write(
      { path: "Task.md", body: "original", baseRevision: null },
      "user",
    );
    if (!(yield* fs.exists(`${notesDir}/task.md`))) return;
    const result = yield* notes
      .write({ path: "task.md", body: "alias", baseRevision: initial.revision }, "agent")
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure" && result.failure._tag === "NoteError")
      assert.strictEqual(result.failure.reason, "invalid_path");
    assert.strictEqual((yield* notes.read({ path: "Task.md" })).body, "original");
  }).pipe(Effect.provide(layer())),
);

it.effect("ordinary edits and watcher refreshes retain enriched results in upserts", () => {
  const running: ThreadResult = {
    runId: RunId.make("running"),
    runStatus: "running",
    outcome: null,
    reportedAt: null,
    pullRequests: [],
    commits: [],
    branch: null,
  };
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* notes.write({ path: "task.md", body: "task", baseRevision: null }, "user");
    const initial = yield* notes.link("task.md", linked);
    const ready = yield* Deferred.make<void>();
    const updates = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type === "upserted"),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* notes.write(
      { path: initial.path, body: "edited", baseRevision: initial.revision },
      "agent",
    );
    yield* fs.writeFileString(`${notesDir}/task.md`, "---\nthreads: [thread-1]\n---\nexternal");
    yield* notes.refresh;
    for (const event of yield* Fiber.join(updates)) {
      if (event.type === "upserted")
        assert.deepStrictEqual(event.note.threads[0]?.lastResult, running);
    }
  }).pipe(Effect.provide(layer(() => Effect.succeed(running))));
});

it.effect("directory replacement after validation cannot write outside the notes root", () =>
  Effect.gen(function* () {
    let armed = false;
    const swapped = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "notes-race-outside-" });
      yield* fs.makeDirectory(`${notesDir}/folder`);
      armed = true;
      const write = yield* notes
        .write({ path: "folder/new.md", body: "must stay inside", baseRevision: null }, "agent")
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(swapped);
      yield* fs.rename(`${notesDir}/folder`, `${notesDir}/original`);
      yield* fs.symlink(outside, `${notesDir}/folder`);
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(write);
      assert.deepStrictEqual(yield* fs.readDirectory(outside), []);
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(
      Effect.provide(
        layer(undefined, undefined, (fs) => ({
          ...fs,
          makeTempDirectoryScoped: (options) =>
            Effect.gen(function* () {
              if (armed && options?.prefix === ".note-") {
                armed = false;
                yield* Deferred.succeed(swapped, undefined);
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
  "result updates use the thread index and keep it correct through moves and deletion",
  () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      for (const name of ["one.md", "two.md"]) {
        yield* notes.write({ path: name, body: name, baseRevision: null }, "user");
        yield* notes.link(name, linked);
      }
      yield* notes.write({ path: "unrelated.md", body: "other", baseRevision: null }, "user");
      yield* notes.link("unrelated.md", {
        ...linked,
        threadId: ThreadId.make("other"),
        host: "unrelated-host",
      });
      calls.length = 0;
      yield* notes.refreshResults(linked.threadId, null);
      assert.deepStrictEqual(calls, [linked.threadId]);
      const one = yield* notes.cached("one.md");
      assert.isDefined(one);
      const moved = yield* notes.move(
        { from: "one.md", to: "folder/moved.md", baseRevision: one!.revision },
        "user",
      );
      const two = yield* notes.cached("two.md");
      yield* notes.delete({ path: "two.md", baseRevision: two!.revision });
      assert.deepStrictEqual(
        (yield* notes.linked(linked.threadId, null)).map((note) => note.path),
        [moved.path],
      );
      calls.length = 0;
      yield* notes.refreshResults("unlinked", null);
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        layer((link) =>
          Effect.sync(() => {
            calls.push(link.threadId);
            return null;
          }),
        ),
      ),
    );
  },
);

it.effect("read, move and delete refuse file symlinks and folder case aliases", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write(
      { path: "Project/Task.md", body: "keep", baseRevision: null },
      "user",
    );
    yield* fs.symlink(`${notesDir}/Project/Task.md`, `${notesDir}/link.md`);
    const paths = ["link.md"];
    if (yield* fs.exists(`${notesDir}/project/Task.md`))
      paths.push("project/Task.md", "Project/task.md");
    for (const path of paths) {
      const read = yield* notes.read({ path }).pipe(Effect.flip);
      assert.strictEqual(read.reason, "invalid_path");
      const move = yield* notes
        .move({ from: path, to: "moved.md", baseRevision: initial.revision }, "agent")
        .pipe(Effect.flip);
      assert.strictEqual(move._tag, "NoteError");
      if (move._tag === "NoteError") assert.strictEqual(move.reason, "invalid_path");
      const removed = yield* notes
        .delete({ path, baseRevision: initial.revision })
        .pipe(Effect.flip);
      assert.strictEqual(removed._tag, "NoteError");
      if (removed._tag === "NoteError") assert.strictEqual(removed.reason, "invalid_path");
    }
    assert.strictEqual((yield* notes.read({ path: initial.path })).body, "keep");
  }).pipe(Effect.provide(layer())),
);

it.effect("refresh removes an externally deleted note loaded before watcher publication", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* fs.writeFileString(`${notesDir}/external.md`, "---\nthreads: [thread-1]\n---\nwork");
    yield* notes.read({ path: "external.md" });
    assert.strictEqual((yield* notes.linked(linked.threadId, null)).length, 1);
    yield* fs.remove(`${notesDir}/external.md`);
    yield* notes.refresh;
    assert.deepStrictEqual(yield* notes.all, []);
    assert.deepStrictEqual(yield* notes.linked(linked.threadId, null), []);
  }).pipe(
    Effect.provide(
      layer(undefined, undefined, (fs) => ({
        ...fs,
        watch: (_path, options) =>
          Stream.unwrap(
            Effect.sync(() => {
              options?.onReady?.();
              return Stream.never;
            }),
          ),
      })),
    ),
  ),
);

it.effect.each(["read", "refreshResults", "complete"] as const)(
  "an older %s cannot overwrite a newer result refresh",
  (operation) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const running: ThreadResult = {
        runId: RunId.make("run"),
        runStatus: "running",
        outcome: null,
        reportedAt: null,
        pullRequests: [],
        commits: [],
        branch: null,
      };
      const succeeded: ThreadResult = { ...running, runStatus: "completed", outcome: "succeeded" };
      let hold = false;
      yield* Effect.gen(function* () {
        const notes = yield* Notes.NotesService;
        yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
        const initial = yield* notes.link("task.md", linked);
        hold = true;
        const old = yield* (
          operation === "read"
            ? notes.read({ path: "task.md" })
            : operation === "complete"
              ? notes.complete("task.md", linked)
              : notes.refreshResults(linked.threadId, null)
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* notes.refreshResults(linked.threadId, null);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(old);
        assert.deepStrictEqual((yield* notes.cached("task.md"))?.threads[0]?.lastResult, succeeded);
        const changes = yield* notes.subscribeChanges;
        const next = yield* changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
        yield* notes.write(
          { path: "task.md", body: "edited", baseRevision: initial.revision },
          "user",
        );
        const event = (yield* Fiber.join(next))[0];
        assert.strictEqual(event?.type, "upserted");
        if (event?.type === "upserted")
          assert.deepStrictEqual(event.note.threads[0]?.lastResult, succeeded);
      }).pipe(
        Effect.provide(
          layer(() =>
            Effect.gen(function* () {
              if (hold) {
                hold = false;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return running;
              }
              return succeeded;
            }),
          ),
        ),
      );
    }),
);

it.effect("dirty-path deletion removes a note loaded before watcher publication", () =>
  Effect.gen(function* () {
    const trigger = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      yield* notes.write({ path: "marker.md", body: "before", baseRevision: null }, "user");
      yield* fs.writeFileString(`${notesDir}/external.md`, "---\nthreads: [thread-1]\n---\nwork");
      yield* notes.read({ path: "external.md" });
      yield* fs.remove(`${notesDir}/external.md`);
      yield* fs.writeFileString(`${notesDir}/marker.md`, "after");
      const changes = yield* notes.subscribeChanges;
      const processed = yield* changes.pipe(
        Stream.filter((event) => event.type === "upserted" && event.note.path === "marker.md"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.succeed(trigger, undefined);
      yield* Deferred.await(delivered);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(processed);
      assert.deepStrictEqual(
        (yield* notes.all).map((note) => note.path),
        ["marker.md"],
      );
      assert.deepStrictEqual(yield* notes.linked(linked.threadId, null), []);
    }).pipe(
      Effect.provide(
        layer(undefined, undefined, (fs) => ({
          ...fs,
          watch: (_path, options) =>
            Stream.unwrap(
              Effect.sync(() => {
                options?.onReady?.();
                return Stream.concat(
                  Stream.fromEffect(Deferred.await(trigger)).pipe(
                    Stream.flatMap(() =>
                      Stream.make(
                        { _tag: "Remove" as const, path: "external.md" },
                        { _tag: "Update" as const, path: "marker.md" },
                      ),
                    ),
                  ),
                  Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
                );
              }),
            ),
        })),
      ),
    );
  }),
);

it.effect.each([
  "before completion",
  "while waiting for the lock",
  "while loading the note",
] as const)("a supplied success superseded %s cannot complete a note", (timing) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const succeeded: ThreadResult = {
      runId: RunId.make("old-run"),
      runStatus: "completed",
      outcome: "succeeded",
      reportedAt: null,
      pullRequests: [],
      commits: [],
      branch: null,
    };
    const running: ThreadResult = {
      ...succeeded,
      runId: RunId.make("new-run"),
      runStatus: "running",
      outcome: null,
    };
    let hold = false;
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
      const initial = yield* notes.link("task.md", linked);
      const observed = initial.threads[0]!.lastResult;
      hold = true;
      const writer = yield* notes
        .write({ path: "blocker.md", body: "hold the lock", baseRevision: null }, "user")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const refresh = () =>
        notes
          .refreshResults(linked.threadId, null, running)
          .pipe(Effect.forkScoped({ startImmediately: true }));
      const newer = timing === "before completion" ? yield* refresh() : undefined;
      if (timing === "while loading the note") {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
      }
      const completion = yield* notes
        .complete("task.md", linked, observed)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const waiting = newer ?? (yield* refresh());
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      const completed = yield* Fiber.join(completion);
      yield* Fiber.join(waiting);
      assert.isFalse(completed);
      const current = yield* notes.cached("task.md");
      assert.strictEqual(current?.status, "doing");
      assert.deepStrictEqual(current?.threads[0]?.lastResult, running);
      yield* notes.refreshResults(linked.threadId, null, succeeded);
      assert.isTrue(yield* notes.complete("task.md", linked, succeeded));
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(succeeded),
          undefined,
          (fs) => ({
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
          }),
        ),
      ),
    );
  }),
);

// An external writer acting while a note write prepares its temp file, after the revision check.
it.effect("an external edit after the revision check is refused, not overwritten", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    external.arm(fs.writeFileString(`${notesDir}/a.md`, "# Terminal\n").pipe(Effect.orDie));
    const conflict = yield* notes
      .write({ path: "a.md", body: "# Mine\n", baseRevision: initial.revision }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    if (conflict._tag === "NoteConflictError")
      assert.strictEqual(conflict.current.body, "# Terminal\n");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
  }).pipe(Effect.provide(external.layer));
});

it.effect("creating a note refuses a file another process created meanwhile", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    external.arm(fs.writeFileString(`${notesDir}/new.md`, "terminal\n").pipe(Effect.orDie));
    const exists = yield* notes
      .write({ path: "new.md", body: "mine\n", baseRevision: null }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(exists._tag === "NoteError" && exists.reason, "exists");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/new.md`), "terminal\n");
  }).pipe(Effect.provide(external.layer));
});

it.effect("a move keeps a source edited during the move and leaves no destination", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    external.arm(fs.writeFileString(`${notesDir}/a.md`, "# Terminal\n").pipe(Effect.orDie));
    const conflict = yield* notes
      .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
    assert.isFalse(yield* fs.exists(`${notesDir}/b.md`));
  }).pipe(Effect.provide(external.layer));
});

it.effect("linking a thread re-reads a note edited during the update", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    external.arm(fs.writeFileString(`${notesDir}/a.md`, "# Terminal\n").pipe(Effect.orDie));
    const note = yield* notes.link("a.md", linked);
    assert.strictEqual(note.body, "# Terminal\n");
    assert.strictEqual(note.status, "doing");
    assert.deepStrictEqual(
      note.threads.map((link) => link.threadId),
      [linked.threadId],
    );
  }).pipe(Effect.provide(external.layer));
});

it.effect("summary titles are capped without splitting a surrogate pair", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const note = yield* notes.write(
      {
        path: "long.md",
        body: `# ${"x".repeat(NOTE_TITLE_MAX_LENGTH - 2)}😀tail\n`,
        baseRevision: null,
      },
      "user",
    );
    assert.isAtMost(note.title.length, NOTE_TITLE_MAX_LENGTH);
    assert.isTrue(note.title.endsWith("x…"));
    assert.isTrue(isSummary((yield* notes.list({})).notes[0]));
  }).pipe(Effect.provide(layer())),
);

type Promises = typeof NodeFS.promises;
/** Replaces a node:fs/promises function the service imports, for the scope's lifetime. */
const replaceFs = <K extends "link" | "copyFile" | "unlink" | "rename">(
  key: K,
  replacement: (original: Promises[K]) => Promises[K],
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const original = NodeFS.promises[key];
      NodeFS.promises[key] = replacement(original);
      NodeModule.syncBuiltinESMExports();
      return original;
    }),
    (original) =>
      Effect.sync(() => {
        NodeFS.promises[key] = original;
        NodeModule.syncBuiltinESMExports();
      }),
  );

/** An editor saves the source right after the service's last revision check, before the source leaves its path. */
const editBeforeRemoval = (name: string, contents: string) => {
  let armed = true;
  const edit = async (target: unknown) => {
    if (!armed || !String(target).endsWith(`/${name}`)) return;
    armed = false;
    await NodeFS.promises.writeFile(String(target), contents);
  };
  return Effect.all([
    replaceFs("unlink", (original) => async (target) => {
      await edit(target);
      return original(target);
    }),
    replaceFs("rename", (original) => async (from, to) => {
      await edit(from);
      return original(from, to);
    }),
  ]);
};

it.effect(
  "a move keeps a source edited after its last revision check and reports the conflict",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const initial = yield* notes.write(
        { path: "a.md", body: "# A\n", baseRevision: null },
        "user",
      );
      yield* editBeforeRemoval("a.md", "# Terminal\n");
      const conflict = yield* notes
        .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "NoteConflictError");
      if (conflict._tag === "NoteConflictError")
        assert.strictEqual(conflict.current.body, "# Terminal\n");
      assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
      assert.deepStrictEqual(yield* fs.readDirectory(notesDir), ["a.md"]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect(
  "a delete keeps a note edited after its last revision check and reports the conflict",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const initial = yield* notes.write(
        { path: "a.md", body: "# A\n", baseRevision: null },
        "user",
      );
      yield* editBeforeRemoval("a.md", "# Terminal\n");
      const conflict = yield* notes
        .delete({ path: "a.md", baseRevision: initial.revision })
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "NoteConflictError");
      assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
      assert.deepStrictEqual(yield* fs.readDirectory(notesDir), ["a.md"]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("a failed move keeps a destination edited after it was placed", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    yield* replaceFs("link", (original) => async (source, destination) => {
      await original(source, destination);
      await NodeFS.promises.writeFile(destination, "# Edited destination\n");
      await NodeFS.promises.writeFile(`${notesDir}/a.md`, "# Edited source\n");
    });
    const conflict = yield* notes
      .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    assert.strictEqual(
      yield* Effect.promise(() => NodeFS.promises.readFile(`${notesDir}/b.md`, "utf8")),
      "# Edited destination\n",
    );
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("volumes without hard links still never replace a file at creation", () => {
  let armed = false;
  const createFirst = (destination: unknown) =>
    armed
      ? NodeFS.promises.writeFile(String(destination), "terminal\n").then(() => {
          armed = false;
        })
      : Promise.resolve();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* replaceFs(
      "link",
      () => () => Promise.reject(Object.assign(new Error("no hard links"), { code: "ENOTSUP" })),
    );
    yield* replaceFs("copyFile", (original) => async (source, destination, mode) => {
      await createFirst(destination);
      return original(source, destination, mode);
    });
    const created = yield* notes.write(
      { path: "a.md", body: "mine\n", baseRevision: null },
      "user",
    );
    assert.strictEqual(created.body, "mine\n");
    armed = true;
    const exists = yield* notes
      .write({ path: "new.md", body: "mine\n", baseRevision: null }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(exists._tag === "NoteError" && exists.reason, "exists");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/new.md`), "terminal\n");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layer(undefined, undefined, (fs) => ({
        ...fs,
        rename: (from, to) =>
          Effect.promise(() => createFirst(to)).pipe(Effect.andThen(fs.rename(from, to))),
      })),
    ),
  );
});
