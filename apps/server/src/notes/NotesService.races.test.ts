// @effect-diagnostics-next-line nodeBuiltinImport:off -- tests replace node:fs/promises calls inside the service.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Config from "../config.ts";
import * as Notes from "./NotesService.ts";
import { notesLayer as layer } from "./NotesTestkit.ts";

// External writers racing the service's own filesystem calls, injected at the syscall it makes.
type Promises = typeof NodeFS.promises;
/** Replaces a node:fs/promises function the service imports, for the scope's lifetime. */
const replaceFs = <K extends "link" | "copyFile" | "unlink" | "rename" | "open">(
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

/** The one hidden folder a removal left behind, and the note contents captured in it. */
const capturedNote = Effect.fn("NotesRacesTest.capturedNote")(function* (notesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(notesDir);
  const hidden = entries.filter((entry) => entry.startsWith(".note-"));
  assert.strictEqual(hidden.length, 1);
  const location = `${hidden[0]}/removed.md`;
  return { entries, location, contents: yield* fs.readFileString(`${notesDir}/${location}`) };
});

it.effect("a file created at an edited note's path meanwhile is kept, and so is the edit", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    yield* replaceFs("rename", (original) => async (from, to) => {
      if (!String(from).endsWith("/a.md")) return original(from, to);
      await NodeFS.promises.writeFile(String(from), "# Terminal\n");
      await original(from, to);
      await NodeFS.promises.writeFile(String(from), "# Other\n");
    });
    const failed = yield* notes
      .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(failed._tag === "NoteError" && failed.reason, "storage");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Other\n");
    const captured = yield* capturedNote(notesDir);
    assert.strictEqual(captured.contents, "# Terminal\n");
    assert.include(failed.message, captured.location);
    assert.deepStrictEqual(
      captured.entries.filter((entry) => !entry.startsWith(".")),
      ["a.md"],
    );
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect(
  "a note that cannot be renamed aside on its own volume is kept and the move refused",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const initial = yield* notes.write(
        { path: "a.md", body: "# A\n", baseRevision: null },
        "user",
      );
      const before = yield* fs.readFileString(`${notesDir}/a.md`);
      yield* replaceFs(
        "rename",
        (original) => (from, to) =>
          String(from).endsWith("/a.md")
            ? Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" }))
            : original(from, to),
      );
      const refused = yield* notes
        .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag === "NoteError" && refused.reason, "storage");
      assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), before);
      assert.deepStrictEqual(yield* fs.readDirectory(notesDir), ["a.md"]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
);

// A copy would be visible before it is complete, so an editor saving into it could be overwritten.
it.effect(
  "an edited note is never put back by copying, so without hard links it stays captured",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const { notesDir } = yield* Config.ServerConfig;
      const initial = yield* notes.write(
        { path: "a.md", body: "# A\n", baseRevision: null },
        "user",
      );
      yield* editBeforeRemoval("a.md", "# Terminal\n");
      yield* replaceFs(
        "link",
        (original) => (source, target) =>
          String(target).endsWith("/a.md")
            ? Promise.reject(Object.assign(new Error("no hard links"), { code: "ENOTSUP" }))
            : original(source, target),
      );
      const failed = yield* notes
        .delete({ path: "a.md", baseRevision: initial.revision })
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag === "NoteError" && failed.reason, "storage");
      const captured = yield* capturedNote(notesDir);
      assert.strictEqual(captured.contents, "# Terminal\n");
      assert.include(failed.message, captured.location);
      assert.strictEqual(captured.entries.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("a set-aside note that cannot be read back is put back, never deleted", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    const before = yield* fs.readFileString(`${notesDir}/a.md`);
    yield* replaceFs(
      "open",
      (original) =>
        (target, ...rest) =>
          String(target).endsWith("/removed.md")
            ? Promise.reject(Object.assign(new Error("i/o error"), { code: "EIO" }))
            : original(target, ...rest),
    );
    const failed = yield* notes
      .delete({ path: "a.md", baseRevision: initial.revision })
      .pipe(Effect.flip);
    assert.strictEqual(failed._tag, "NoteConflictError");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), before);
    assert.deepStrictEqual(yield* fs.readDirectory(notesDir), ["a.md"]);
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("interrupting a delete after its note was set aside still puts the edit back", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    const renamed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    yield* replaceFs("rename", (original) => async (from, to) => {
      if (!String(from).endsWith("/a.md")) return original(from, to);
      await NodeFS.promises.writeFile(String(from), "# Terminal\n");
      await original(from, to);
      renamed.resolve();
      await release.promise;
    });
    const removal = yield* notes
      .delete({ path: "a.md", baseRevision: initial.revision })
      .pipe(Effect.forkScoped);
    yield* Effect.promise(() => renamed.promise);
    removal.interruptUnsafe();
    release.resolve();
    assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(removal)));
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
