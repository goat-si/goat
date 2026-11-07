// @effect-diagnostics nodeBuiltinImport:off -- the tests stage pending uploads and symlinks the way the filesystem sees them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, rm: vi.fn(actual.rm), copyFile: vi.fn(actual.copyFile) };
});

import * as AttachmentFileLeases from "../assets/AttachmentFileLeases.ts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { attachNoteFile } from "./NoteAttachments.ts";
import * as NotesGit from "./NotesGit.ts";
import * as Notes from "./NotesService.ts";
import { notesLayer } from "./NotesTestkit.ts";

const makeLayer = (onChanged: () => void) =>
  Layer.mergeAll(
    AttachmentFileLeases.layer,
    Layer.succeed(NotesGit.NotesGit, {
      changed: Effect.sync(onChanged),
      flush: Effect.void,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-note-attachments-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const pending = (bytes: string, extension?: string) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const attachmentId = createPendingAttachmentId(extension);
    const file = NodePath.join(attachmentsDir, `${attachmentId}${extension ?? ".png"}`);
    yield* Effect.promise(() => NodeFSP.writeFile(file, bytes));
    return { attachmentId, file };
  });

const exists = (file: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(file).then(
      () => true,
      () => false,
    ),
  );

describe("attachNoteFile", () => {
  it.effect("moves an upload into the notes under its content hash and dedupes repeats", () => {
    let changes = 0;
    return Effect.gen(function* () {
      const { notesDir } = yield* ServerConfig.ServerConfig;
      const image = yield* pending("png bytes");
      const result = yield* attachNoteFile({ attachmentId: image.attachmentId });
      expect(result.path).toMatch(/^\.attachments\/[0-9a-f]{16}\.png$/);
      const published = NodePath.join(notesDir, result.path);
      expect(yield* Effect.promise(() => NodeFSP.readFile(published, "utf8"))).toBe("png bytes");
      expect(yield* exists(image.file)).toBe(false);
      expect(changes).toBe(1);

      const again = yield* pending("png bytes");
      expect(yield* attachNoteFile({ attachmentId: again.attachmentId })).toEqual(result);

      const document = yield* pending("%PDF-1.7", ".pdf");
      expect((yield* attachNoteFile({ attachmentId: document.attachmentId })).path).toMatch(
        /\.pdf$/,
      );
      const folder = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(notesDir, ".attachments")),
      );
      expect(folder.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    }).pipe(Effect.provide(makeLayer(() => changes++)));
  });

  it.effect("refuses ids that are not finished uploads", () =>
    Effect.gen(function* () {
      expect(
        yield* attachNoteFile({ attachmentId: "thread-1-not-a-uuid" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_path" });
      expect(
        yield* attachNoteFile({ attachmentId: createPendingAttachmentId() }).pipe(Effect.flip),
      ).toMatchObject({ reason: "not_found" });
    }).pipe(Effect.provide(makeLayer(() => {}))),
  );

  it.effect.skipIf(!symlinksSupported)(
    "never writes through a linked attachment folder or destination",
    () =>
      Effect.gen(function* () {
        const { notesDir } = yield* ServerConfig.ServerConfig;
        const outside = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(notesDir), "goat-outside-")),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(notesDir, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, NodePath.join(notesDir, ".attachments")),
        );
        const first = yield* pending("linked folder");
        expect(
          yield* attachNoteFile({ attachmentId: first.attachmentId }).pipe(Effect.flip),
        ).toMatchObject({ reason: "storage" });
        expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual([]);

        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(notesDir, ".attachments")));
        const probe = yield* pending("linked destination");
        const name = (yield* attachNoteFile({ attachmentId: probe.attachmentId })).path;
        const destination = NodePath.join(notesDir, name);
        yield* Effect.promise(() => NodeFSP.unlink(destination));
        yield* Effect.promise(() => NodeFSP.symlink(NodePath.join(outside, "target"), destination));
        const second = yield* pending("linked destination");
        expect(
          yield* attachNoteFile({ attachmentId: second.attachmentId }).pipe(Effect.flip),
        ).toMatchObject({ reason: "storage" });
        expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual([]);
      }).pipe(Effect.provide(makeLayer(() => {}))),
  );

  it.effect("refuses a name already holding different bytes and leaves it alone", () =>
    Effect.gen(function* () {
      const { notesDir } = yield* ServerConfig.ServerConfig;
      const probe = yield* pending("original");
      const name = (yield* attachNoteFile({ attachmentId: probe.attachmentId })).path;
      const destination = NodePath.join(notesDir, name);
      yield* Effect.promise(() => NodeFSP.writeFile(destination, "someone else's file"));
      const retry = yield* pending("original");
      expect(
        yield* attachNoteFile({ attachmentId: retry.attachmentId }).pipe(Effect.flip),
      ).toMatchObject({ reason: "storage" });
      expect(yield* Effect.promise(() => NodeFSP.readFile(destination, "utf8"))).toBe(
        "someone else's file",
      );
    }).pipe(Effect.provide(makeLayer(() => {}))),
  );

  it.effect("publishes one file when the same bytes arrive concurrently", () =>
    Effect.gen(function* () {
      const { notesDir } = yield* ServerConfig.ServerConfig;
      const uploads = yield* Effect.forEach([1, 2, 3], () => pending("same bytes"));
      const results = yield* Effect.forEach(
        uploads,
        (upload) => attachNoteFile({ attachmentId: upload.attachmentId }),
        { concurrency: "unbounded" },
      );
      expect(new Set(results.map((result) => result.path)).size).toBe(1);
      const folder = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(notesDir, ".attachments")),
      );
      expect(folder).toEqual([NodePath.basename(results[0]!.path)]);
    }).pipe(Effect.provide(makeLayer(() => {}))),
  );

  it.effect("still signals a commit when the temp file cannot be removed", () => {
    let changes = 0;
    return Effect.gen(function* () {
      const upload = yield* pending("cleanup fails");
      vi.mocked(NodeFSP.rm).mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "EBUSY" }),
      );
      const result = yield* attachNoteFile({ attachmentId: upload.attachmentId });
      expect(result.path).toMatch(/\.png$/);
      expect(changes).toBe(1);
    }).pipe(Effect.provide(makeLayer(() => changes++)));
  });

  it.effect("finishes publishing and signals when interrupted during the copy", () => {
    let changes = 0;
    return Effect.gen(function* () {
      const { notesDir } = yield* ServerConfig.ServerConfig;
      const upload = yield* pending("interrupted");
      let started!: () => void;
      let release!: () => void;
      const copying = new Promise<void>((resolve) => (started = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const actualCopy = vi.mocked(NodeFSP.copyFile).getMockImplementation()!;
      vi.mocked(NodeFSP.copyFile).mockImplementationOnce(async (...args) => {
        started();
        await released;
        return actualCopy(...args);
      });
      const fiber = yield* attachNoteFile({ attachmentId: upload.attachmentId }).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => copying);
      const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      release();
      yield* Fiber.join(interrupting);
      const folder = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(notesDir, ".attachments")),
      );
      expect(folder.filter((name) => name.endsWith(".png") && !name.startsWith("."))).toHaveLength(
        1,
      );
      expect(changes).toBe(1);
    }).pipe(Effect.provide(makeLayer(() => changes++)));
  });
});

it.effect("an attachment folder never appears among notes", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const { notesDir } = yield* ServerConfig.ServerConfig;
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(notesDir, ".attachments"), { recursive: true }),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(notesDir, ".attachments", "uploaded.md"), "# not a note"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(notesDir, "real.md"), "# real"));
    const listed = yield* notes.list({});
    expect(listed.notes.map((note) => note.path)).toEqual(["real.md"]);
    expect(listed.folders).toEqual([]);
  }).pipe(Effect.provide(notesLayer())),
);
