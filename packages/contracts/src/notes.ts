import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ThreadResult } from "./threadResult.ts";

/**
 * Notes are markdown files under the hub's notes directory. A top-level folder is a project;
 * the hierarchy stops there, so a path is `note.md` or `folder/note.md`.
 */
export const NOTE_PATH_MAX_LENGTH = 300;
/** A folder name, alone or as the first segment of a NotePath. */
export const NOTE_FOLDER_MAX_LENGTH = 120;
/** Display titles travel in every summary, so a long first heading is cut to this many UTF-16 units. */
export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_PREVIEW_MAX_LENGTH = 140;
/** Bodies are documents a person edits, not attachments; the cap keeps a write one frame. */
export const NOTE_BODY_MAX_BYTES = 1024 * 1024;

const isNoteSegment = (segment: string) =>
  segment.length > 0 &&
  !segment.startsWith(".") &&
  segment.trim() === segment &&
  !/[\u0000-\u001f\u007f\\/:]/u.test(segment);

/** Canonical NFC, so two spellings of one name cannot address the same file twice. */
const isNfc = (value: string) => value === value.normalize("NFC");
const isFolderName = (value: string) =>
  isNfc(value) && value.length <= NOTE_FOLDER_MAX_LENGTH && isNoteSegment(value);

export const NoteFolder = Schema.String.check(
  Schema.makeFilter(isFolderName, {
    expected: "one folder name without slashes, leading dots, or control characters",
  }),
);
export type NoteFolder = typeof NoteFolder.Type;

export const NotePath = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      if (!isNfc(value) || value.length > NOTE_PATH_MAX_LENGTH || !value.endsWith(".md"))
        return false;
      const segments = value.split("/");
      if (segments.length > 2) return false;
      if (segments.length === 2 && !isFolderName(segments[0]!)) return false;
      const file = segments.at(-1) ?? "";
      return segments.every(isNoteSegment) && file.length > ".md".length;
    },
    {
      expected: "a relative .md path with at most one folder, such as ideas.md or project/ideas.md",
    },
  ),
);
export type NotePath = typeof NotePath.Type;

/** sha256 hex of the file's bytes. Edits made outside GOAT change it too. */
export const NoteRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type NoteRevision = typeof NoteRevision.Type;

export const NoteStatus = Schema.Literals(["idea", "doing", "done"]);
export type NoteStatus = typeof NoteStatus.Type;

export const NoteAuthor = Schema.Literals(["user", "agent"]);
export type NoteAuthor = typeof NoteAuthor.Type;

export const NoteThreadRef = Schema.Struct({
  threadId: ThreadId,
  host: Schema.NullOr(TrimmedNonEmptyString),
});
export type NoteThreadRef = typeof NoteThreadRef.Type;

/** A thread started from the note. host is null for this environment. */
export const NoteThreadLink = Schema.Struct({
  threadId: ThreadId,
  host: Schema.NullOr(TrimmedNonEmptyString),
  /** The thread's latest run result when this environment knows it. */
  lastResult: Schema.NullOr(ThreadResult),
});
export type NoteThreadLink = typeof NoteThreadLink.Type;

export const NoteSummary = Schema.Struct({
  path: NotePath,
  folder: Schema.NullOr(NoteFolder),
  /** The first heading, else the first body line or file name, cut to NOTE_TITLE_MAX_LENGTH. */
  title: Schema.String.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH)),
  status: NoteStatus,
  /** A hub that supports notes.update always sends this; clients use its absence to detect older hubs. */
  pinned: Schema.optional(Schema.Boolean),
  preview: Schema.optional(Schema.String.check(Schema.isMaxLength(NOTE_PREVIEW_MAX_LENGTH))),
  /** Threads linked for reference; unlike threads, these never drive status. */
  related: Schema.optional(Schema.Array(NoteThreadRef)),
  threads: Schema.Array(NoteThreadLink),
  updatedBy: Schema.NullOr(NoteAuthor),
  revision: NoteRevision,
  updatedAt: IsoDateTime,
  size: NonNegativeInt,
});
export type NoteSummary = typeof NoteSummary.Type;

export const NoteDocument = Schema.Struct({
  ...NoteSummary.fields,
  /** Markdown without the frontmatter, which the server owns. */
  body: Schema.String,
});
export type NoteDocument = typeof NoteDocument.Type;

export const NotesListInput = Schema.Struct({
  folder: Schema.optional(NoteFolder),
});
export type NotesListInput = typeof NotesListInput.Type;

export const NotesListResult = Schema.Struct({
  notes: Schema.Array(NoteSummary),
  folders: Schema.Array(NoteFolder),
  /** True when the folder holds more notes than one list returns. */
  truncated: Schema.Boolean,
});
export type NotesListResult = typeof NotesListResult.Type;

export const NotesReadInput = Schema.Struct({ path: NotePath });
export type NotesReadInput = typeof NotesReadInput.Type;

export const NotesWriteInput = Schema.Struct({
  path: NotePath,
  body: Schema.String,
  status: Schema.optional(NoteStatus),
  /** The revision the edit started from; null creates the note and refuses when it exists. */
  baseRevision: Schema.NullOr(NoteRevision),
});
export type NotesWriteInput = typeof NotesWriteInput.Type;

export const NotesUpdateInput = Schema.Struct({
  path: NotePath,
  pinned: Schema.optional(Schema.Boolean),
  relate: Schema.optional(NoteThreadRef),
  unrelate: Schema.optional(NoteThreadRef),
});
export type NotesUpdateInput = typeof NotesUpdateInput.Type;

export const NotesMoveInput = Schema.Struct({
  from: NotePath,
  to: NotePath,
  baseRevision: NoteRevision,
});
export type NotesMoveInput = typeof NotesMoveInput.Type;

export const NotesDeleteInput = Schema.Struct({
  path: NotePath,
  baseRevision: NoteRevision,
});
export type NotesDeleteInput = typeof NotesDeleteInput.Type;

export const NotesDeleteResult = Schema.Struct({ path: NotePath });
export type NotesDeleteResult = typeof NotesDeleteResult.Type;

export const NotesSubscribeInput = Schema.Struct({});
export type NotesSubscribeInput = typeof NotesSubscribeInput.Type;

/** The first event is a snapshot; later ones change one note. Clients read bodies on demand. */
export const NotesEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    notes: Schema.Array(NoteSummary),
    folders: Schema.Array(NoteFolder),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("upserted"), note: NoteSummary }),
  Schema.Struct({ type: Schema.Literal("removed"), path: NotePath }),
]);
export type NotesEvent = typeof NotesEvent.Type;

/** Where work from a note runs: one of this hub's projects, or a project on a machine it reaches. */
export const NoteWorkTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hub"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("host"),
    /** An SSH alias or linked host name, as notes.workTargets lists it. */
    host: TrimmedNonEmptyString,
    /** Absolute folder of an existing project on that machine. */
    projectPath: TrimmedNonEmptyString,
  }),
]);
export type NoteWorkTarget = typeof NoteWorkTarget.Type;

export const NoteWorkspaceStrategy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type NoteWorkspaceStrategy = typeof NoteWorkspaceStrategy.Type;

export const NotesStartWorkInput = Schema.Struct({
  path: NotePath,
  /** Stable per attempt: a retry with the same id returns the same thread instead of a second one. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  target: NoteWorkTarget,
  /** Defaults to the hub's default model for new threads. */
  modelSelection: Schema.optional(ModelSelection),
  /** Defaults to the project folder itself. */
  workspace: Schema.optional(NoteWorkspaceStrategy),
});
export type NotesStartWorkInput = typeof NotesStartWorkInput.Type;

export const NotesStartWorkResult = Schema.Struct({
  note: NoteDocument,
  threadId: ThreadId,
  host: Schema.NullOr(TrimmedNonEmptyString),
});
export type NotesStartWorkResult = typeof NotesStartWorkResult.Type;

export const NotesWorkTargetsInput = Schema.Struct({});
export type NotesWorkTargetsInput = typeof NotesWorkTargetsInput.Type;

export const NotesWorkTargetsResult = Schema.Struct({
  hub: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({ projectId: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
    ),
  }),
  hosts: Schema.Array(
    Schema.Struct({
      host: TrimmedNonEmptyString,
      label: Schema.String,
      kind: Schema.Literals(["ssh", "linked"]),
    }),
  ),
});
export type NotesWorkTargetsResult = typeof NotesWorkTargetsResult.Type;

export const NotesWorkTargetProjectsInput = Schema.Struct({ host: TrimmedNonEmptyString });
export type NotesWorkTargetProjectsInput = typeof NotesWorkTargetProjectsInput.Type;

export const NotesWorkTargetProjectsResult = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ title: Schema.String, path: Schema.String })),
});
export type NotesWorkTargetProjectsResult = typeof NotesWorkTargetProjectsResult.Type;

export const NoteErrorReason = Schema.Literals([
  "not_found",
  "exists",
  "invalid_path",
  "too_large",
  "launch_failed",
  /** A remote launch's outcome is unknown; check the host's threads before starting again. */
  "launch_ambiguous",
  "host_unavailable",
  "storage",
]);
export type NoteErrorReason = typeof NoteErrorReason.Type;

export class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
  reason: NoteErrorReason,
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

/**
 * The note changed since baseRevision. current is what is on disk now, so a person can compare
 * and choose, and an agent can re-read and retry.
 */
export class NoteConflictError extends Schema.TaggedError<NoteConflictError>()(
  "NoteConflictError",
  {
    path: NotePath,
    current: NoteDocument,
    message: Schema.String,
  },
) {}
