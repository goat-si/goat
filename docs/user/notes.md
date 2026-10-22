# Notes

Notes are markdown documents kept on the GOAT server you connect to (your hub). People and agents edit the same files, and a note can start work in a thread and follow it until it is done. Open **Notes** from the sidebar or the command palette on web and desktop, or from the notes button on the mobile home screen.

## Where notes live

Each note is a `.md` file in the `notes` folder of the server's data directory: `~/.goat/notes` for `goat serve` and SSH hosts, and `~/.goat/desktop/notes` for the desktop app. A note sits at the top of the folder or inside one folder; a folder is a project, and notes do not nest deeper than that. You can edit the files with any editor or from a terminal, and open clients show the change within a second or two.

The top of each file holds a small header that GOAT keeps up to date:

```yaml
---
status: idea # idea, doing or done
threads: [...] # threads started from this note
updatedBy: user # user or agent
---
```

The notes folder is a git repository. GOAT commits every change a couple of seconds after it lands, including edits made outside GOAT, so you can see who changed what and restore an older version with ordinary git commands.

## Editing

On web and desktop, notes open in a rich editor with headings, lists, checklists, quotes, and code blocks, and save as you type. Markdown that the editor cannot show exactly, such as HTML or tables, stays as an editable source block so it is never rewritten. On mobile, a note shows its checklists as checkboxes you can tap; use **Edit markdown** to change the text.

## When someone else changed the note

Every save names the version it started from. If the note changed in the meantime, GOAT does not overwrite it. You see **This note changed** with both versions and the lines that differ. Choose **Use theirs** to take the current file and drop your draft, or **Keep mine** to save your version over it. If it changes again before you decide, GOAT asks again.

Agents follow the same rule: an agent whose write is refused reads the note again and reapplies its change.

## Writing on your phone without a connection

Edits you make on mobile while the hub is unreachable are kept on the phone, even if you close the app. The note shows that it is saved on this phone, and GOAT sends the changes when it reconnects. If the note changed on the hub in the meantime, the note asks you to compare versions before anything is overwritten.

## Start work from a note

Choose **Start work** (web, desktop) or **Start work from this note** (mobile), then pick where it runs: one of this hub's projects, or a project on a machine the hub reaches over SSH or as a linked host. You can pick a model and whether the work runs in the project folder or a new worktree. The thread receives the note's text, the note moves to **doing**, and the thread appears under **Linked threads**.

When the thread finishes and its agent reports success, the note moves to **done** by itself. A failed, blocked, or cancelled run leaves the note in **doing** and shows the result next to the thread, so you can start again.

If the machine is offline, nothing starts and the note says the host is unavailable; try again once it is back. If starting work on another machine loses its answer, GOAT does not start a second copy on its own. Check that machine's threads, then choose **Start again** if nothing started.

## For agents

Agents use the `goat_note_list`, `goat_note_read`, `goat_note_write`, and `goat_note_move` tools. A write needs the revision from the last read; a refused write means the note changed, so the agent reads it again and retries.
