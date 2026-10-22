import type { AgentSurfaceEntry, CapabilityDeclaration } from "./registry.ts";

/** Note tool metadata, kept beside the registry so its file does not keep growing. */
export const noteSurfaceEntries = {
  list: {
    resource: "note",
    verb: "list",
    name: "goat_note_list",
    toolkit: "note",
    summary: "List the notes on this environment.",
    description:
      "List the markdown notes on this environment (the hub's notes folder). A top-level folder is a project; pass folder to list one. Each note has its path, title, status (idea, doing or done), the threads started from it, who changed it last, and its revision. Bodies are not included; read one with goat_note_read. The same files are on disk, so a person may also be editing them.",
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
      "Read one note by path: its markdown body (without frontmatter, which GOAT manages), status, linked threads and revision. Pass that revision as baseRevision to goat_note_write or goat_note_move.",
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
      "Write a note's whole markdown body, and optionally its status (idea, doing or done). baseRevision is required: the revision goat_note_read returned, or null to create a note that does not exist yet. If the note changed since that revision the write is refused with a conflict and nothing is overwritten: read the note again, apply your change to the current body, and retry with the new revision. To tick a checkbox, change '- [ ]' to '- [x]' on that line and keep the rest of the body as read. Paths are note.md or folder/note.md.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Revision-checked notebook shared by agents and people; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  },
  update: {
    resource: "note",
    verb: "update",
    name: "goat_note_update",
    toolkit: "note",
    summary: "Pin a note or link a thread for reference.",
    description:
      "Pin/unpin a note or link/unlink a thread for reference without changing its body or status. Pass pinned, relate or unrelate with the note path. Thread references contain threadId and host (null for this environment). No baseRevision is needed because the body is untouched.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Changes only a note's pin and reference links in the shared notebook; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  },
  move: {
    resource: "note",
    verb: "move",
    name: "goat_note_move",
    toolkit: "note",
    summary: "Rename a note or move it to another folder.",
    description:
      "Move or rename a note: from and to are note paths (note.md or folder/note.md); a missing folder is created. baseRevision is the revision goat_note_read returned; a changed note is refused with a conflict, so read it again and retry. Refused when to already exists.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Revision-checked notebook shared by agents and people; it reaches no environment, thread or host.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  },
} as const satisfies Record<string, AgentSurfaceEntry & CapabilityDeclaration>;
