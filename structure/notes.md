# Notes

Notes are markdown files under the server's notes directory, edited by people through clients and
by agents through MCP. The file on disk is the source of truth; the server keeps a read model of
it and never stores note content in SQLite. Wire types are `packages/contracts/src/notes.ts`.

## Storage

`ServerConfig.notesDir` (`apps/server/src/config.ts`) is `<baseDir>/notes`, or
`<stateDir>/notes` for dev state so a dev server never reaches a person's notes. A path is
`note.md` or `folder/note.md`: one optional folder level, NFC, no hidden or dot segments.
`NotePath` refuses everything else before the server touches the disk, and the server also refuses
symlinked entries and case aliases of an existing file.

`apps/server/src/notes/frontmatter.ts` reads and writes the header only at byte zero (after an
optional BOM). `status`, `threads`, `related`, `pinned`, and `updatedBy` are GOAT's; other keys are
kept as written, and `related` and `pinned` are omitted while empty. A thread link is stored as
`<threadId>` or `<threadId>@<host>`, split at the last `@`. `threads` are threads started from
the note and drive automatic completion; `related` are threads linked for reference and never do.

A revision is the sha256 of the file's bytes, so an edit made outside GOAT changes it too.

## NotesService

`NotesService` (`apps/server/src/notes/NotesService.ts`) owns list, read, write, update, move,
delete and the change stream. A summary's title is the first heading, else the first body line,
else the file name; its preview is the opening body text after the title line, capped so the
snapshot stays small. Writes, moves, and deletes run under one semaphore, compare `baseRevision` with
the bytes on disk inside it, and write through a temporary file and rename. A mismatch fails with
`NoteConflictError` carrying the current document; nothing is written. `baseRevision: null`
creates and fails when the file exists. The semaphore does not stop a terminal or editor, so the
file is hashed again just before the rename or unlink, and a create links the temporary file into
place, which refuses an existing name (volumes without hard links copy with `COPYFILE_EXCL`
instead). Only the few syscalls between that last check and the rename can still lose an outside
edit. Header updates (pin and reference links), start-work links and automatic completion own no
user revision, so they read the note again and retry up to three times before failing with a
storage error. A local reference link must name a thread this environment has. The author (`updatedBy`) is passed by the caller's
transport: `user` from the WebSocket handlers, `agent` from MCP tools and from automatic
completion.

A recursive `FileSystem.watch` on the root, debounced and coalesced per window, catches edits made
outside GOAT; `.git/` and temporary files are ignored. The service publishes its own writes
immediately instead of waiting for the watcher, which is what keeps an agent's edit within about a
second on a connected client. `notes.subscribe` sends a snapshot of summaries, then `upserted`
and `removed` events. Bodies are read on demand.

## Git

`NotesGit` (`apps/server/src/notes/NotesGit.ts`) initializes the root as its own repository and
commits every change two seconds after the last one, with a fixed author and committer and with
inherited `GIT_*` repository, index, config, and identity variables removed so the commit cannot
land in another repository. A missing `git` binary disables commits and leaves notes working.

## Starting work and finishing it

`NoteWorkService` (`apps/server/src/notes/NoteWorkService.ts`) lists targets (this hub's
projects, plus SSH and linked hosts) and starts a thread with the note's text. SSH hosts come from
the configured aliases without probing each one, so an offline host is reported as
`host_unavailable` when work starts there, and an unreadable host list still leaves the hub's
projects. A hub launch goes
through `ThreadLaunchService.launch` with command and thread ids derived from the note path and
the client's `requestId`, so a retry returns the same thread. A host launch goes through
`SshRemoteDispatch.launchThread`, which takes no request id; the service records an intent in
`<stateDir>/note-work-intents.json` first, and a retry of an attempt whose outcome is unknown fails
with `launch_ambiguous` instead of launching twice. The thread is then linked and the note moves to
`doing`.

`NoteAutoDone` (`apps/server/src/notes/NoteAutoDone.ts`) marks a note `done` when the last
linked thread's run ended `completed` and its reported outcome is `succeeded`. Both are needed:
a report can arrive while the run is still going, and a run that completes without a report proves
nothing. The check runs again under the write lock before writing. Local runs are observed from
the orchestration event stream starting at the current sequence, with reconciliation at startup,
right after linking, and on each relevant event, so there is no cursor to persist. Remote links are
followed through `HostThreadsMcpService` waits with a server-owned scope that only reaches the
linked thread, with a small concurrency cap. `NoteResults` caches each link's latest
`ThreadResult` for the `lastResult` field that clients show.

## Wire and agents

The notes methods and RPCs are in `packages/contracts/src/notesRpc.ts`; `rpc.ts` adds scope
authorization and publishes `WsNotesRpcGroup`, whose handlers
(`apps/server/src/notes/NotesRpcHandlers.ts`) get their own layer in `apps/server/src/ws.ts`. The
summary fields `pinned`, `preview` and `related` are optional on the wire so newer clients read
older hubs; a hub that accepts `notes.update` always sends `pinned`, and clients hide pin and link
controls without it. `CLIENT_GUARDED_RPC_SCOPES` gates list, read,
subscribe, and target reads on orchestration read, and every mutation and `startWork` on
orchestration operate. The MCP toolkit `apps/server/src/mcp/toolkits/note/` exposes
`goat_note_list`, `goat_note_read`, `goat_note_write`, `goat_note_update`, and `goat_note_move` on the
same service, with their metadata in `packages/contracts/src/agentSurface/notes.ts`; a conflict
returns a failure that tells the agent to read and retry.

## Clients

Web (`apps/web/src/notes/`, route `/_chat/notes`) edits with Tiptap using the composer's block
extensions and a note codec, `apps/web/src/notes/noteMarkdown.ts`. Block boundaries come from
`remark-parse` with GFM positions, so they follow CommonMark. The codec only turns a block into
editable structure when serializing it reproduces the source exactly; anything else stays a raw
markdown block, so opening and saving a note never rewrites markdown the editor does not model.
An incoming revision with the same body and status as the editing base is a header change, so the
draft moves onto it without asking to compare; a reread settles one that crosses a save.

Mobile (`apps/mobile/src/features/notes/`) renders notes with tappable checkboxes and edits the
markdown source. The native renderer reports a tapped checkbox by index and label, not by source
position, so a tap is written only when that index, label and state match exactly one task in the
source; otherwise the app asks the person to use the markdown editor. Edits go to an outbox
persisted in the `note_outbox` table of the mobile SQLite
database before they are sent, keyed by environment and path and keeping the revision the edit
started from. The table is not a client cache kind, so clearing caches never drops unsent edits,
and a build that predates it ignores it. The worker flushes when the environment connects or the
app returns to the foreground; a conflict pauses only that note. The queue rules and the line diff
used by the compare screen are pure code in `packages/client-runtime/src/notes/`.
