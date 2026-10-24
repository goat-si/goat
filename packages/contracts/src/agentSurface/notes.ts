import type { AgentSurfaceEntry, CapabilityDeclaration } from "./registry.ts";
import { NOTE_REVISION } from "./idempotencyReasons.ts";

/** Note tool metadata, kept beside the registry so its file does not keep growing. */
export const noteSurfaceEntries = {
  list: {
    resource: "note",
    verb: "list",
    name: "goat_note_list",
    toolkit: "note",
    summary: "List the notes on this environment.",
    description:
      "List markdown note summaries on this environment, optionally within one folder. Bodies are omitted; read a note with goat_note_read. Listings stop at 500 paths (check truncated) and skip unreadable notes. People can edit the same files on disk.",
    guide:
      "Notes live in this environment's notes folder, the hub's notes folder. A top-level folder is a project; pass folder to list one. Each note includes its path, title, status (idea, doing or done), threads started from it, last author and revision. Bodies are not included; use goat_note_read for the body. A person can edit these same files on disk.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  read: {
    resource: "note",
    verb: "read",
    name: "goat_note_read",
    toolkit: "note",
    summary: "Read one note's markdown and revision.",
    description:
      "Read a note's markdown body, status, linked threads and revision by path. The body excludes GOAT-managed frontmatter. Use the revision when writing or moving the note.",
    guide:
      "Pass the returned revision as baseRevision to goat_note_write or goat_note_move. GOAT manages frontmatter separately from the returned markdown body.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  write: {
    resource: "note",
    verb: "write",
    name: "goat_note_write",
    toolkit: "note",
    summary: "Create or replace a note's markdown.",
    description:
      "Create or replace a note's whole markdown body and optionally its status. Preserve all text you want to keep; an external disk edit can race with replacement.",
    guide:
      "Write the entire markdown body. Optionally set status to idea, doing or done. baseRevision is required: use the revision from goat_note_read, or null to create a note that does not exist yet.\n\nOn a revision conflict, read again, apply your change to the current body, and retry with the new revision. Revision checks detect changes before replacement but do not make replacement atomic with an external disk editor. To tick a checkbox, replace '- [ ]' with '- [x]' on that line and keep the rest of the body as read. Use note.md or folder/note.md paths.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Revision-checked notebook shared by agents and people; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason: NOTE_REVISION,
    annotations: { idempotentHint: false, openWorldHint: false },
  },
  update: {
    resource: "note",
    verb: "update",
    name: "goat_note_update",
    toolkit: "note",
    summary: "Pin a note or link a thread for reference.",
    description:
      "Pin or unpin a note, or link or unlink a thread, keeping the loaded body and status. It rewrites the file, so an external disk edit can race with it.",
    guide:
      "Pass pinned, relate or unrelate with the note path. A thread reference contains threadId and host; host is null for this environment. No baseRevision is needed because this operation leaves the body untouched.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Changes only a note's pin and reference links in the shared notebook; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "Sets a pin or adds or removes a reference, so a repeat leaves the note the same.",
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  move: {
    resource: "note",
    verb: "move",
    name: "goat_note_move",
    toolkit: "note",
    summary: "Rename a note or move it to another folder.",
    description:
      "Rename a note or move it to another folder, creating a missing destination folder. An external edit to the source during the move can be lost.",
    guide:
      "Use note paths for from and to: note.md or folder/note.md. A missing destination folder is created. Set baseRevision to the revision returned by goat_note_read. On a detected revision conflict, read the note again and retry with its new revision. A different destination that already exists is refused. When from equals to, the call checks the revision and returns the existing note without moving it.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Revision-checked notebook shared by agents and people; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason: NOTE_REVISION,
    annotations: { idempotentHint: false, openWorldHint: false },
  },
} as const satisfies Record<string, AgentSurfaceEntry & CapabilityDeclaration>;
