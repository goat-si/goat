// @effect-diagnostics nodeBuiltinImport:off -- pinned directory handles, exclusive copies and no-replace links have no Effect FileSystem equivalent.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  NOTE_ATTACHMENTS_FOLDER,
  NoteError,
  type NotesAttachInput,
  type NotesAttachResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as AttachmentFileLeases from "../assets/AttachmentFileLeases.ts";
import { discardPendingAttachment } from "../assets/AttachmentUpload.ts";
import {
  parseAttachmentUuid,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { guardErrors } from "@goat/shared/errorGuards";
import * as NotesGit from "./NotesGit.ts";

const storage = new NoteError({ reason: "storage", message: "Couldn’t store the file in notes." });
const DIRECTORY_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_DIRECTORY ?? 0) |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => storage });
const errno = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => (cause as NodeJS.ErrnoException).code ?? "UNKNOWN",
  });

const hashFile = (file: string) =>
  io(
    () =>
      new Promise<string>((resolve, reject) => {
        const hash = NodeCrypto.createHash("sha256");
        guardErrors(NodeFS.createReadStream(file), reject)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolve(hash.digest("hex")));
      }),
  );

const regularFile = (file: string) =>
  errno(() => NodeFSP.lstat(file)).pipe(
    Effect.map((info) => Option.some(info.isFile() && !info.isSymbolicLink())),
    Effect.catch((code) => (code === "ENOENT" ? Effect.succeedNone : Effect.fail(storage))),
  );

/**
 * Pins the notes root and its attachment folder by handle and re-checks both identities on demand.
 * Pathname calls keep a swap window after each check, as for note writes in NotesService: a
 * process that can rename folders here already has the person's write access, which is outside
 * the notes containment threat model.
 */
const pinAttachmentFolder = Effect.fnUntraced(function* (notesDir: string) {
  yield* io(() => NodeFSP.mkdir(notesDir, { recursive: true }));
  const root = yield* io(() => NodeFSP.realpath(notesDir));
  const folder = NodePath.join(root, NOTE_ATTACHMENTS_FOLDER);
  yield* errno(() => NodeFSP.mkdir(folder)).pipe(
    Effect.catch((code) => (code === "EEXIST" ? Effect.void : Effect.fail(storage))),
  );
  const pins: Array<{ readonly absolute: string; readonly handle: NodeFSP.FileHandle }> = [];
  for (const absolute of [root, folder]) {
    const handle = yield* Effect.acquireRelease(
      io(() => NodeFSP.open(absolute, DIRECTORY_FLAGS)),
      (opened) => Effect.promise(() => opened.close()),
    );
    pins.push({ absolute, handle });
  }
  const verify = Effect.forEach(
    pins,
    ({ absolute, handle }) =>
      Effect.gen(function* () {
        const current = yield* io(() => NodeFSP.lstat(absolute));
        const pinned = yield* io(() => handle.stat());
        const real = yield* io(() => NodeFSP.realpath(absolute));
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== pinned.ino ||
          current.dev !== pinned.dev ||
          real !== absolute
        )
          return yield* storage;
      }),
    { discard: true },
  );
  yield* verify;
  return { folder, verify };
});

const publish = Effect.fnUntraced(function* (input: {
  readonly notesDir: string;
  readonly source: string;
  readonly git: NotesGit.NotesGit["Service"];
}) {
  const extension = NodePath.extname(input.source).toLowerCase();
  if (
    !/^\.[a-z0-9]{1,10}$/.test(extension) ||
    !Option.getOrElse(yield* regularFile(input.source), () => false)
  )
    return yield* storage;
  const hash = yield* hashFile(input.source);
  const name = `${hash.slice(0, 16)}${extension}`;
  const { folder, verify } = yield* pinAttachmentFolder(input.notesDir);
  const destination = NodePath.join(folder, name);
  // The same name must hold the same bytes; a prefix collision or a foreign file is refused.
  const reuse = Effect.gen(function* () {
    if (!Option.getOrElse(yield* regularFile(destination), () => false)) return yield* storage;
    if ((yield* hashFile(destination)) !== hash) return yield* storage;
  });
  // Temp names are excluded from Notes commits, so a crash leftover is never committed.
  const temp = NodePath.join(folder, `.tmp-${NodeCrypto.randomUUID()}${extension}`);
  const place = Effect.gen(function* () {
    yield* verify;
    if (Option.isSome(yield* regularFile(destination))) return yield* reuse;
    yield* io(() => NodeFSP.copyFile(input.source, temp, NodeFS.constants.COPYFILE_EXCL));
    yield* verify;
    // link never replaces, unlike rename: a file published meanwhile surfaces as EEXIST.
    const linked = yield* errno(() => NodeFSP.link(temp, destination)).pipe(
      Effect.as(true),
      Effect.catch((code) => (code === "EEXIST" ? Effect.succeed(false) : Effect.fail(storage))),
    );
    if (!linked) yield* reuse;
  }).pipe(
    Effect.ensuring(
      errno(() => NodeFSP.rm(temp, { force: true })).pipe(
        Effect.catch((code) => Effect.logWarning("Notes attachment temp file remains", { code })),
      ),
    ),
  );
  // Once the file is published it must reach a commit, so nothing after the copy is interrupted.
  yield* place.pipe(Effect.andThen(input.git.changed), Effect.uninterruptible);
  return { path: `${NOTE_ATTACHMENTS_FOLDER}/${name}` } satisfies NotesAttachResult;
});

/** Moves a finished pending upload into the notes attachment folder, named by its content hash. */
export const attachNoteFile = Effect.fn("NoteAttachments.attach")(function* (
  input: NotesAttachInput,
) {
  if (
    parseAttachmentUuid(input.attachmentId) === null ||
    parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
  )
    return yield* new NoteError({
      reason: "invalid_path",
      message: "Only a finished upload can be embedded in a note.",
    });
  const config = yield* ServerConfig.ServerConfig;
  const leases = yield* AttachmentFileLeases.AttachmentFileLeases;
  const git = yield* NotesGit.NotesGit;
  const result = yield* leases.withAttachment(
    input.attachmentId,
    Effect.gen(function* () {
      const source = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.attachmentId,
      });
      if (!source)
        return yield* new NoteError({
          reason: "not_found",
          message: "The upload is no longer available.",
        });
      return yield* publish({ notesDir: config.notesDir, source, git }).pipe(Effect.scoped);
    }),
  );
  // Outside the lease, which discarding takes itself; the pending sweep reclaims a leftover.
  yield* discardPendingAttachment(input.attachmentId).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Embedded upload stays pending until the sweep", { cause }),
    ),
  );
  return result;
});

/** NotesService.attach: the pending-upload lease comes from the server, the rest from notes. */
export type Attach = (
  input: NotesAttachInput,
) => Effect.Effect<NotesAttachResult, NoteError, AttachmentFileLeases.AttachmentFileLeases>;

export const bindAttach =
  (
    git: NotesGit.NotesGit["Service"],
    config: ServerConfig.ServerConfig["Service"],
    fs: FileSystem.FileSystem,
  ): Attach =>
  (input) =>
    attachNoteFile(input).pipe(
      Effect.provideService(NotesGit.NotesGit, git),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
