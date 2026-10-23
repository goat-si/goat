// @effect-diagnostics-next-line nodeBuiltinImport:off -- revisions hash the exact UTF-8 file bytes.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- no-follow numeric open flags are absent from Effect FileSystem.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pin directory/file identities across pathname operations.
import * as NodeFSP from "node:fs/promises";
import {
  NOTE_BODY_MAX_BYTES,
  NOTE_TITLE_MAX_LENGTH,
  NOTE_PREVIEW_MAX_LENGTH,
  NoteConflictError,
  NoteError,
  NoteFolder,
  NotePath,
  type NoteAuthor,
  type NoteDocument,
  type NotesDeleteInput,
  type NotesDeleteResult,
  type NotesEvent,
  type NotesListInput,
  type NotesListResult,
  type NotesMoveInput,
  type NotesReadInput,
  type NotesWriteInput,
  type NotesUpdateInput,
  type NoteThreadRef,
  type NoteSummary,
  type NoteThreadLink,
  type ThreadResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../config.ts";
import { parseNote, serializeNote, type NoteContents } from "./frontmatter.ts";
import * as NotesGit from "./NotesGit.ts";
import * as NoteResults from "./NoteResults.ts";

const decodePath = Schema.decodeEffect(NotePath);
const decodeFolder = Schema.decodeEffect(NoteFolder);
const isPath = Schema.is(NotePath);
const isFolder = Schema.is(NoteFolder);
const LIST_LIMIT = 500;
const MAX_FILE_BYTES = NOTE_BODY_MAX_BYTES + 256 * 1024;
const summary = ({ body: _body, ...note }: NoteDocument): NoteSummary => note;
const displayText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
};
const displayTitle = (title: string) => displayText(title, NOTE_TITLE_MAX_LENGTH);
const stripMarkers = (line: string) =>
  line
    .trim()
    .replace(/^(?:(?:#{1,6}|[-*+>]|\d+\.)\s+|\[[ xX]\]\s*)+/u, "")
    .trim();
const bodySummary = (body: string, fallback: string) => {
  const lines = body.split(/\r?\n/u);
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/mu.exec(body);
  const titleIndex = heading
    ? body.slice(0, heading.index).split("\n").length - 1
    : lines.findIndex((line) => line.trim().length > 0);
  const firstLine = lines[titleIndex];
  const title = heading?.[1] ?? (firstLine === undefined ? fallback : stripMarkers(firstLine));
  const preview = lines
    .filter((line, index) => index !== titleIndex && !/^\s*(?:`{3,}|~{3,})/u.test(line))
    .map(stripMarkers)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    title: displayTitle(title || fallback),
    preview: displayText(preview, NOTE_PREVIEW_MAX_LENGTH),
  };
};
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export class NotesService extends Context.Service<
  NotesService,
  {
    readonly list: (input: NotesListInput) => Effect.Effect<NotesListResult, NoteError>;
    readonly read: (input: NotesReadInput) => Effect.Effect<NoteDocument, NoteError>;
    readonly write: (
      input: NotesWriteInput,
      author: NoteAuthor,
    ) => Effect.Effect<NoteDocument, NoteError | NoteConflictError>;
    readonly update: (input: NotesUpdateInput) => Effect.Effect<NoteDocument, NoteError>;
    readonly move: (
      input: NotesMoveInput,
      author: NoteAuthor,
    ) => Effect.Effect<NoteDocument, NoteError | NoteConflictError>;
    readonly delete: (
      input: NotesDeleteInput,
    ) => Effect.Effect<NotesDeleteResult, NoteError | NoteConflictError>;
    readonly subscribe: Stream.Stream<NotesEvent, NoteError>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<NotesEvent>, never, Scope.Scope>;
    readonly link: (path: NotePath, link: NoteThreadLink) => Effect.Effect<NoteDocument, NoteError>;
    readonly complete: (
      path: NotePath,
      link: NoteThreadLink,
      observed?: ThreadResult | null,
    ) => Effect.Effect<boolean, NoteError>;
    readonly cached: (path: NotePath) => Effect.Effect<NoteDocument | undefined>;
    readonly linked: (
      threadId: string,
      host: string | null,
    ) => Effect.Effect<ReadonlyArray<NoteDocument>>;
    readonly refresh: Effect.Effect<void, NoteError>;
    readonly all: Effect.Effect<ReadonlyArray<NoteDocument>, NoteError>;
    readonly refreshResults: (
      threadId: string,
      host: string | null,
      observed?: ThreadResult,
    ) => Effect.Effect<void, NoteError>;
  }
>()("goat/notes/NotesService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* NotesGit.NotesGit;
  const results = yield* NoteResults.NoteResults;
  const projections = yield* Projections.ProjectionStoreV2;
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<NotesEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const storage = new NoteError({ reason: "storage", message: "Note storage is unavailable." });
  yield* fs
    .makeDirectory(config.notesDir, { recursive: true })
    .pipe(Effect.mapError(() => storage));
  const root = yield* fs.realPath(config.notesDir).pipe(Effect.mapError(() => storage));
  const known = new Map<NotePath, string>();
  const readModel = new Map<NotePath, NoteDocument>();
  const threadNotes = new Map<string, Set<NotePath>>();
  const resultCache = new Map<string, ThreadResult | null>();
  const resultVersions = new Map<string, bigint>();
  const resultLookups = new Map<string, number>();
  let resultSequence = 0n;
  const releaseResult = (id: string) => {
    if (threadNotes.has(id) || resultLookups.has(id)) return;
    resultVersions.delete(id);
    resultCache.delete(id);
  };
  const threadKey = (threadId: string, host: string | null) => JSON.stringify([host, threadId]);
  const forget = (name: NotePath, retained?: ReadonlySet<string>) => {
    for (const link of readModel.get(name)?.threads ?? []) {
      const key = threadKey(link.threadId, link.host);
      const paths = threadNotes.get(key);
      paths?.delete(name);
      if (paths?.size === 0) {
        threadNotes.delete(key);
        if (!retained?.has(key)) releaseResult(key);
      }
    }
    readModel.delete(name);
  };
  const rememberDocument = (note: NoteDocument) => {
    forget(note.path, new Set(note.threads.map((link) => threadKey(link.threadId, link.host))));
    const enriched = {
      ...note,
      threads: note.threads.map((link) => ({
        ...link,
        lastResult: resultCache.has(threadKey(link.threadId, link.host))
          ? resultCache.get(threadKey(link.threadId, link.host))!
          : link.lastResult,
      })),
    };
    readModel.set(note.path, enriched);
    for (const link of note.threads) {
      const key = threadKey(link.threadId, link.host);
      const paths = threadNotes.get(key) ?? new Set<NotePath>();
      paths.add(note.path);
      threadNotes.set(key, paths);
    }
    return enriched;
  };
  const linked = (threadId: string, host: string | null) =>
    Effect.sync(() =>
      [...(threadNotes.get(threadKey(threadId, host)) ?? [])].flatMap((name) => {
        const note = readModel.get(name);
        return note ? [note] : [];
      }),
    );

  const invalidPath = (name: string) =>
    new NoteError({
      reason: "invalid_path",
      message: "Use the exact spelling of a regular note path without symlinks.",
      path: name,
    });
  const io = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        return code === "ENOENT"
          ? new NoteError({ reason: "not_found", message: "The note was not found.", path: name })
          : code === "ELOOP" || code === "ENOTDIR"
            ? invalidPath(name)
            : storage;
      },
    });
  const open = (name: string, absolute: string, flags: number) =>
    Effect.acquireRelease(
      io(name, () => NodeFSP.open(absolute, flags)),
      (handle) => Effect.promise(() => handle.close()),
    );
  const pinDirectory = Effect.fnUntraced(function* (input: string, create = false) {
    const name = yield* decodePath(input).pipe(Effect.mapError(() => invalidPath(input)));
    const directoryFlags =
      NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_DIRECTORY ?? 0) |
      (NodeFS.constants.O_NOFOLLOW ?? 0);
    const pins: Array<{ absolute: string; handle: NodeFSP.FileHandle }> = [];
    const rootHandle = yield* open(name, root, directoryFlags);
    pins.push({ absolute: root, handle: rootHandle });
    const verify = Effect.gen(function* () {
      for (const pin of pins) {
        const current = yield* io(name, () => NodeFSP.lstat(pin.absolute));
        const pinned = yield* io(name, () => pin.handle.stat());
        const real = yield* io(name, () => NodeFSP.realpath(pin.absolute));
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== pinned.ino ||
          current.dev !== pinned.dev ||
          real !== pin.absolute
        )
          return yield* invalidPath(name);
      }
    });
    const segments = name.split("/");
    let parent = root;
    if (segments.length === 2) {
      yield* verify;
      const folder = segments[0]!;
      const entries = yield* io(name, () => NodeFSP.readdir(root));
      parent = path.join(root, folder);
      const info = yield* io(name, () => NodeFSP.lstat(parent)).pipe(
        Effect.catchTags({
          NoteError: (error) =>
            error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (info && (!entries.includes(folder) || info.isSymbolicLink()))
        return yield* invalidPath(name);
      if (!info && create) yield* fs.makeDirectory(parent).pipe(Effect.mapError(() => storage));
      const handle = yield* open(name, parent, directoryFlags);
      pins.push({ absolute: parent, handle });
    }
    yield* verify;
    const absolute = path.join(parent, segments.at(-1)!);
    const verifyFile = Effect.gen(function* () {
      yield* verify;
      const info = yield* io(name, () => NodeFSP.lstat(absolute)).pipe(
        Effect.catchTags({
          NoteError: (error) =>
            error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (info) {
        const entries = yield* io(name, () => NodeFSP.readdir(parent));
        if (!info.isFile() || info.isSymbolicLink() || !entries.includes(segments.at(-1)!))
          return yield* invalidPath(name);
      }
      return info;
    });
    yield* verifyFile;
    const pinTemporary = (absolute: string) =>
      Effect.gen(function* () {
        const handle = yield* open(name, absolute, directoryFlags);
        pins.push({ absolute, handle });
        yield* verify;
      });
    return { name, absolute, parent, verify, verifyFile, pinTemporary };
  });

  const load = Effect.fnUntraced(function* (input: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(input);
        const { name, absolute } = directory;
        const handle = yield* open(
          name,
          absolute,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        yield* directory.verify;
        const info = yield* io(name, () => handle.stat());
        if (!info.isFile()) return yield* invalidPath(name);
        if (info.size > MAX_FILE_BYTES)
          return yield* new NoteError({
            reason: "too_large",
            message: "The note is too large.",
            path: name,
          });
        const bytes = yield* io(name, () => handle.readFile());
        yield* directory.verify;
        const contents = yield* Effect.try({
          try: () => parseNote(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          catch: () => storage,
        });
        const document: NoteDocument = {
          path: name,
          folder: name.includes("/") ? name.split("/")[0]! : null,
          ...bodySummary(contents.body, path.basename(name, ".md")),
          pinned: contents.pinned,
          related: contents.related,
          status: contents.status,
          threads: contents.threads,
          updatedBy: contents.updatedBy,
          revision: sha256(bytes),
          updatedAt: info.mtime.toISOString(),
          size: bytes.byteLength,
          body: contents.body,
        };
        return { document: rememberDocument(document), contents, absolute };
      }),
    );
  });
  const optionalLoad = (name: string) =>
    load(name).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  const lookupResult = Effect.fnUntraced(function* (
    link: NoteThreadLink,
    observed?: ThreadResult | null,
  ) {
    const id = threadKey(link.threadId, link.host);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        // Tokens must never repeat when an unlinked thread is evicted and later reintroduced.
        const version = ++resultSequence;
        resultVersions.set(id, version);
        resultLookups.set(id, (resultLookups.get(id) ?? 0) + 1);
        return version;
      }),
      (version) =>
        Effect.gen(function* () {
          const lastResult = observed === undefined ? yield* results.latest(link) : observed;
          if (resultVersions.get(id) === version) resultCache.set(id, lastResult);
          return { id, version, lastResult };
        }),
      () =>
        Effect.sync(() => {
          const remaining = resultLookups.get(id)! - 1;
          if (remaining === 0) resultLookups.delete(id);
          else resultLookups.set(id, remaining);
          releaseResult(id);
        }),
    );
  });
  const enrich = (note: NoteDocument) =>
    Effect.forEach(note.threads, (link) => lookupResult(link), { concurrency: 4 }).pipe(
      Effect.map(() => {
        // Result updates do not change the file revision; merge the current cache after all lookups.
        const enriched = {
          ...note,
          threads: note.threads.map((link) => ({
            ...link,
            lastResult: resultCache.get(threadKey(link.threadId, link.host)) ?? null,
          })),
        };
        if (readModel.get(note.path)?.revision === note.revision)
          readModel.set(note.path, enriched);
        return enriched;
      }),
    );
  const publish = (note: NoteDocument) =>
    Effect.gen(function* () {
      const enriched = rememberDocument(note);
      known.set(note.path, note.revision);
      yield* PubSub.publish(events, { type: "upserted", note: summary(enriched) });
      yield* git.changed;
    });
  const removed = (name: NotePath) =>
    Effect.gen(function* () {
      known.delete(name);
      forget(name);
      yield* PubSub.publish(events, { type: "removed", path: name });
      yield* git.changed;
    });
  const persist = Effect.fnUntraced(function* (
    name: NotePath,
    contents: NoteContents,
    /** The revision the caller read, or null to create a note that must not exist yet. */
    expected: string | null,
    emit = true,
  ) {
    const bytes = new TextEncoder().encode(serializeNote(contents));
    if (bytes.byteLength > MAX_FILE_BYTES)
      return yield* new NoteError({
        reason: "too_large",
        message: "The note is too large.",
        path: name,
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(name, true);
        yield* directory.verifyFile;
        const temporary = yield* fs
          .makeTempDirectoryScoped({ directory: directory.parent, prefix: ".note-" })
          .pipe(Effect.mapError(() => storage));
        yield* directory.verifyFile;
        yield* directory.pinTemporary(temporary);
        const temp = path.join(temporary, "contents.tmp");
        const handle = yield* open(
          name,
          temp,
          NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        yield* directory.verify;
        yield* io(name, () => handle.writeFile(bytes));
        yield* directory.verifyFile;
        // Pathname syscalls retain a directory-swap window after these checks, including cleanup.
        // A process able to rename folders here already has the user's write access, so such swaps
        // are outside the notes containment threat model.
        if (expected === null) yield* createExclusive(name, temp, directory.absolute);
        else {
          yield* expectOnDisk(name, directory.absolute, expected);
          // POSIX has no compare-and-rename, so an edit landing between this check and rename(2)
          // is still replaced. The window is a few syscalls instead of the whole write.
          yield* fs.rename(temp, directory.absolute).pipe(Effect.mapError(() => storage));
        }
        yield* directory.verify;
      }),
    );
    const { document } = yield* load(name);
    if (emit) yield* publish(document);
    return document;
  });
  const unlink = (name: NotePath, expected: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(name);
        yield* directory.verifyFile;
        yield* expectOnDisk(name, directory.absolute, expected);
        // POSIX has no compare-and-unlink, so the file is renamed aside and checked again there.
        // rename(2) takes whatever is at the path at that instant, so an edit landing after the
        // check above is put back instead of deleted. A writer that keeps the file open and writes
        // after the second check is the remaining window.
        let keepAside = false;
        const aside = yield* Effect.acquireRelease(
          fs
            .makeTempDirectory({ directory: directory.parent, prefix: ".note-" })
            .pipe(Effect.mapError(() => storage)),
          (temporary) =>
            keepAside
              ? Effect.void
              : fs.remove(temporary, { recursive: true }).pipe(Effect.ignore({ log: true })),
        );
        yield* directory.pinTemporary(aside);
        const removed = path.join(aside, "removed.md");
        // Never fall back to copy and unlink (EXDEV, EBUSY on a bind-mounted file): that reopens
        // the window this rename closes. The note stays where it is.
        yield* io(name, () => NodeFSP.rename(directory.absolute, removed)).pipe(
          Effect.mapError((error) =>
            error.reason === "storage"
              ? new NoteError({
                  reason: "storage",
                  message: "The note was kept because it could not be moved aside for removal.",
                  path: name,
                })
              : error,
          ),
        );
        if ((yield* diskRevision(name, removed)) !== expected) {
          // link(2) never replaces a file created at the path since the rename. That file is the
          // later write, which would have replaced this one without the move, so it is kept.
          yield* createExclusive(name, removed, directory.absolute).pipe(
            Effect.catchTags({
              NoteError: (error) =>
                error.reason === "exists"
                  ? Effect.void
                  : Effect.sync(() => {
                      keepAside = true;
                    }).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new NoteError({
                            reason: "storage",
                            message: `The note changed while it was being removed and could not be put back. Its contents are in ${path.relative(root, removed)}.`,
                            path: name,
                          }),
                        ),
                      ),
                    ),
            }),
          );
          return yield* changedOnDisk(name, expected);
        }
        forget(name);
        yield* directory.verify;
      }),
    );
  const checkRevision = (document: NoteDocument, revision: string) =>
    document.revision === revision
      ? Effect.void
      : Effect.fail(
          new NoteConflictError({
            path: document.path,
            current: document,
            message: "The note changed. Read it again before retrying.",
          }),
        );
  const conflictMessage = "The note changed. Read it again before retrying.";
  /** The revision of the bytes at absolute now, or null when no file is there. */
  const diskRevision = (name: NotePath, absolute: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* open(
          name,
          absolute,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        const info = yield* io(name, () => handle.stat());
        // Larger than any revision a caller can hold, so it can only differ.
        if (info.size > MAX_FILE_BYTES) return "";
        return sha256(yield* io(name, () => handle.readFile()));
      }),
    ).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  /** Fails unless the file still holds the revision the caller decided on. */
  const expectOnDisk = Effect.fnUntraced(function* (
    name: NotePath,
    absolute: string,
    expected: string | null,
  ) {
    if ((yield* diskRevision(name, absolute)) === expected) return;
    return yield* changedOnDisk(name, expected);
  });
  /** The error for a note whose file no longer holds the expected revision. */
  const changedOnDisk = Effect.fnUntraced(function* (name: NotePath, expected: string | null) {
    const current = yield* optionalLoad(name);
    if (!current)
      return yield* new NoteError({
        reason: "not_found",
        message: "The note was not found.",
        path: name,
      });
    if (expected === null)
      return yield* new NoteError({
        reason: "exists",
        message: "The note already exists.",
        path: name,
      });
    return yield* new NoteConflictError({
      path: name,
      current: current.document,
      message: conflictMessage,
    });
  });
  /** link(2) refuses an existing destination, so a file created meanwhile is never replaced. */
  const createExclusive = (name: NotePath, temp: string, absolute: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.link(temp, absolute),
      catch: (cause) => (cause as NodeJS.ErrnoException).code,
    }).pipe(
      Effect.catch((code) =>
        code === "EEXIST"
          ? Effect.fail(
              new NoteError({
                reason: "exists",
                message: "The note already exists.",
                path: name,
              }),
            )
          : code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP"
            ? // Volumes without hard links copy with O_EXCL instead: still never replacing a file,
              // though a reader can briefly see a partial copy.
              Effect.tryPromise({
                try: () => NodeFSP.copyFile(temp, absolute, NodeFS.constants.COPYFILE_EXCL),
                catch: (cause) =>
                  (cause as NodeJS.ErrnoException).code === "EEXIST"
                    ? new NoteError({
                        reason: "exists",
                        message: "The note already exists.",
                        path: name,
                      })
                    : storage,
              })
            : Effect.fail(storage),
      ),
    );
  /** Header updates, link and complete own no user revision, so a racing edit makes them read again. */
  const rereadOnConflict = <A>(effect: Effect.Effect<A, NoteError | NoteConflictError>) =>
    effect.pipe(
      Effect.retry({ times: 3, while: (error) => error._tag === "NoteConflictError" }),
      Effect.catchTags({
        NoteConflictError: () =>
          Effect.fail(
            new NoteError({
              reason: "storage",
              message: "The note kept changing during the update. Try again.",
            }),
          ),
      }),
    );

  const scan = Effect.fnUntraced(function* (input: NotesListInput, limit = LIST_LIMIT) {
    if (input.folder !== undefined)
      yield* decodeFolder(input.folder).pipe(
        Effect.mapError(
          () => new NoteError({ reason: "invalid_path", message: "Invalid note folder." }),
        ),
      );
    const entries = yield* fs.readDirectory(root).pipe(Effect.mapError(() => storage));
    const folders: Array<string> = [];
    const names: Array<NotePath> = [];
    let truncated = false;
    const add = (name: string) => {
      if (!isPath(name)) return;
      if (names.length < limit) names.push(name);
      else truncated = true;
    };
    for (const entry of entries.toSorted()) {
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(root, entry);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory" && isFolder(entry)) {
        const real = yield* fs.realPath(entryPath).pipe(Effect.option);
        if (
          Option.isNone(real) ||
          path.relative(root, real.value).startsWith("..") ||
          path.isAbsolute(path.relative(root, real.value))
        )
          continue;
        folders.push(entry);
        if (input.folder !== undefined && entry !== input.folder) continue;
        const children = yield* fs.readDirectory(entryPath).pipe(Effect.mapError(() => storage));
        for (const child of children.toSorted()) add(`${entry}/${child}`);
      } else if (input.folder === undefined) add(entry);
    }
    const notes = yield* Effect.forEach(
      names,
      (name) =>
        load(name).pipe(
          Effect.map(({ document }) => document),
          Effect.option,
        ),
      { concurrency: 4 },
    );
    return { notes: notes.filter(Option.isSome).map((note) => note.value), folders, truncated };
  });
  const read: NotesService["Service"]["read"] = (input) =>
    lock
      .withPermits(1)(load(input.path))
      .pipe(Effect.flatMap(({ document }) => enrich(document)));
  const list: NotesService["Service"]["list"] = (input) =>
    lock
      .withPermits(1)(scan(input))
      .pipe(
        Effect.flatMap((result) =>
          Effect.forEach(result.notes, enrich, { concurrency: 4 }).pipe(
            Effect.map((notes) => ({ ...result, notes: notes.map(summary) })),
          ),
        ),
      );
  const write: NotesService["Service"]["write"] = (input, author) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (new TextEncoder().encode(input.body).byteLength > NOTE_BODY_MAX_BYTES)
            return yield* new NoteError({
              reason: "too_large",
              message: "The note body exceeds 1 MiB.",
              path: input.path,
            });
          const existing = yield* optionalLoad(input.path);
          if (existing && input.baseRevision === null)
            return yield* new NoteError({
              reason: "exists",
              message: "The note already exists.",
              path: input.path,
            });
          if (!existing && input.baseRevision !== null)
            return yield* new NoteError({
              reason: "not_found",
              message: "The note was not found.",
              path: input.path,
            });
          if (existing && input.baseRevision !== null)
            yield* checkRevision(existing.document, input.baseRevision);
          return yield* persist(
            input.path,
            {
              metadata: existing?.contents.metadata ?? null,
              body: input.body,
              status: input.status ?? existing?.contents.status ?? "idea",
              threads: existing?.contents.threads ?? [],
              pinned: existing?.contents.pinned ?? false,
              related: existing?.contents.related ?? [],
              updatedBy: author,
            },
            existing?.document.revision ?? null,
          );
        }),
      )
      .pipe(Effect.flatMap(enrich));
  const update = Effect.fn("NotesService.update")(function* (input: NotesUpdateInput) {
    return yield* lock
      .withPermits(1)(
        rereadOnConflict(
          Effect.gen(function* () {
            const source = yield* load(input.path);
            const sameRef = (left: NoteThreadRef, right: NoteThreadRef) =>
              left.threadId === right.threadId && left.host === right.host;
            const pinned = input.pinned ?? source.contents.pinned;
            let related = source.contents.related;
            const ref = input.relate;
            if (
              ref &&
              ![...source.contents.threads, ...related].some((entry) => sameRef(entry, ref))
            ) {
              if (ref.host === null) {
                const thread = yield* projections.getThread(ref.threadId).pipe(
                  Effect.catchTags({
                    ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                  }),
                  Effect.mapError(() => storage),
                );
                if (!thread || thread.deletedAt !== null)
                  return yield* new NoteError({
                    reason: "not_found",
                    message: "The thread was not found in this environment.",
                    path: input.path,
                  });
              }
              related = [...related, ref];
            }
            if (input.unrelate) {
              const ref = input.unrelate;
              related = related.filter((entry) => !sameRef(entry, ref));
            }
            if (
              pinned === source.contents.pinned &&
              related.length === source.contents.related.length &&
              related.every((entry, index) => {
                const before = source.contents.related[index];
                return before !== undefined && sameRef(entry, before);
              })
            )
              return source.document;
            return yield* persist(
              input.path,
              { ...source.contents, pinned, related },
              source.document.revision,
            );
          }),
        ),
      )
      .pipe(Effect.flatMap(enrich));
  });
  const move: NotesService["Service"]["move"] = (input, author) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const source = yield* load(input.from);
          yield* checkRevision(source.document, input.baseRevision);
          if (input.from === input.to) return source.document;
          if (yield* optionalLoad(input.to))
            return yield* new NoteError({
              reason: "exists",
              message: "The destination already exists.",
              path: input.to,
            });
          const contents: NoteContents = { ...source.contents, updatedBy: author };
          const document = yield* persist(input.to, contents, null, false);
          // Roll back only the bytes this move placed; a destination edited since then stays.
          const placed = sha256(new TextEncoder().encode(serializeNote(contents)));
          yield* unlink(source.document.path, source.document.revision).pipe(
            Effect.tapError(() => unlink(input.to, placed).pipe(Effect.ignore({ log: true }))),
          );
          yield* publish(document);
          yield* removed(input.from);
          return document;
        }),
      )
      .pipe(Effect.flatMap(enrich));
  const remove: NotesService["Service"]["delete"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const source = yield* load(input.path);
        yield* checkRevision(source.document, input.baseRevision);
        yield* unlink(source.document.path, source.document.revision);
        yield* removed(input.path);
        return { path: input.path };
      }),
    );
  const link: NotesService["Service"]["link"] = (name, entry) =>
    lock
      .withPermits(1)(
        rereadOnConflict(
          Effect.gen(function* () {
            const source = yield* load(name);
            if (
              source.contents.threads.some(
                (link) => link.threadId === entry.threadId && link.host === entry.host,
              )
            )
              return source.document;
            return yield* persist(
              name,
              {
                ...source.contents,
                status: "doing",
                updatedBy: "user",
                threads: [...source.contents.threads, entry],
              },
              source.document.revision,
            );
          }),
        ),
      )
      .pipe(Effect.flatMap(enrich));
  const complete: NotesService["Service"]["complete"] = (name, entry, observed) =>
    Effect.gen(function* () {
      const id = threadKey(entry.threadId, entry.host);
      const lookup = observed === undefined ? yield* lookupResult(entry) : null;
      const result = lookup ? lookup.lastResult : observed;
      if (result?.runStatus !== "completed" || result.outcome !== "succeeded") return false;
      return yield* lock.withPermits(1)(
        rereadOnConflict(
          Effect.gen(function* () {
            const version = lookup ? lookup.version : resultVersions.get(id);
            const isCurrent = () =>
              version !== undefined &&
              resultVersions.get(id) === version &&
              resultCache.get(id) === result;
            if (!isCurrent()) return false;
            const source = yield* optionalLoad(name);
            const last = source?.contents.threads.at(-1);
            if (
              !isCurrent() ||
              !source ||
              source.contents.status !== "doing" ||
              last?.threadId !== entry.threadId ||
              last.host !== entry.host
            )
              return false;
            yield* persist(
              name,
              { ...source.contents, status: "done", updatedBy: "agent" },
              source.document.revision,
            );
            return true;
          }),
        ),
      );
    });
  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* scan({}, Infinity);
      const present = new Set(snapshot.notes.map((note) => note.path));
      for (const note of snapshot.notes)
        if (known.get(note.path) !== note.revision) yield* publish(note);
      for (const name of new Set([...known.keys(), ...readModel.keys()]))
        if (!present.has(name)) yield* removed(name);
    }),
  );
  const all = Effect.sync(() => [...readModel.values()]);
  const refreshResults: NotesService["Service"]["refreshResults"] = (threadId, host, observed) =>
    Effect.gen(function* () {
      if ((yield* linked(threadId, host)).length === 0) return;
      const lookup = yield* lookupResult(
        {
          threadId: threadId as NoteThreadLink["threadId"],
          host,
          lastResult: null,
        },
        observed,
      );
      const { lastResult } = lookup;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (resultVersions.get(lookup.id) !== lookup.version) return;
          for (const note of yield* linked(threadId, host)) {
            const enriched = rememberDocument({
              ...note,
              threads: note.threads.map((link) =>
                link.threadId === threadId && link.host === host ? { ...link, lastResult } : link,
              ),
            });
            yield* PubSub.publish(events, { type: "upserted", note: summary(enriched) });
          }
        }),
      );
    });
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the snapshot while holding the same lock as every writer.
      const initial = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          const snapshot = yield* scan({});
          return { subscription, snapshot };
        }),
      );
      const notes = yield* Effect.forEach(initial.snapshot.notes, enrich, { concurrency: 4 });
      return Stream.concat(
        Stream.succeed<NotesEvent>({
          type: "snapshot",
          ...initial.snapshot,
          notes: notes.map(summary),
        }),
        Stream.fromSubscription(initial.subscription),
      );
    }),
  );
  for (const note of (yield* scan({}, Infinity)).notes) known.set(note.path, note.revision);
  const ready = yield* Deferred.make<void>();
  const dirty = new Set<string>();
  const refreshDirty = lock.withPermits(1)(
    Effect.gen(function* () {
      const paths = [...dirty];
      dirty.clear();
      for (const name of paths) {
        if (!isPath(name)) continue;
        const loaded = yield* optionalLoad(name).pipe(Effect.option);
        if (Option.isNone(loaded)) continue;
        const source = loaded.value;
        if (source && known.get(name) !== source.document.revision) yield* publish(source.document);
        else if (!source && (known.has(name) || readModel.has(name))) yield* removed(name);
      }
    }),
  );
  yield* fs
    .watch(root, { recursive: true, onReady: () => Deferred.doneUnsafe(ready, Effect.void) })
    .pipe(
      Stream.map((event) =>
        path
          .relative(root, path.isAbsolute(event.path) ? event.path : path.join(root, event.path))
          .split(path.sep)
          .join("/"),
      ),
      Stream.filter((name) => !name.split("/").some((segment) => segment.startsWith("."))),
      Stream.tap((name) =>
        Effect.sync(() => {
          dirty.add(name);
        }),
      ),
      Stream.debounce("100 millis"),
      Stream.runForEach(() => {
        const fullScan = [...dirty].some((name) => !isPath(name));
        if (fullScan) {
          dirty.clear();
          return refresh.pipe(Effect.ignore({ log: true }));
        }
        return refreshDirty.pipe(Effect.ignore({ log: true }));
      }),
      Effect.catch(() =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Effect.logWarning("Notes filesystem watcher unavailable")),
        ),
      ),
      Effect.forkScoped,
    );
  yield* Deferred.await(ready);
  yield* git.changed;
  return NotesService.of({
    list,
    read,
    write,
    update,
    move,
    delete: remove,
    subscribe,
    subscribeChanges: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    link,
    complete,
    refresh,
    all,
    refreshResults,
    linked,
    cached: (name) => Effect.sync(() => readModel.get(name)),
  });
});
export const layer = Layer.effect(NotesService, make);
