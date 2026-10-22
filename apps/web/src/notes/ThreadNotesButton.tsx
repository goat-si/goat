import { useAtomValue } from "@effect/atom-react";
import {
  NoteFolder,
  type EnvironmentId,
  type NoteSummary,
  type NoteThreadRef,
  type ThreadId,
} from "@goat/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { FileTextIcon, PlusIcon, XIcon } from "~/components/solar";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { notesRpc, notesSubscription } from "../rpc/notes/atoms";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { filterNotes, noteErrorMessage, orderNotes, supportsNoteUpdate } from "./noteState";
import { useCreateNote } from "./useCreateNote";
import { useNoteCommand } from "./useNoteCommand";

const isNoteFolder = Schema.is(NoteFolder);
const LINK_RESULTS = 6;

/**
 * Notes live on the primary environment, and a link with host null names a thread there, so
 * threads on other environments get no button rather than a link that points nowhere.
 */
export function ThreadNotesButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectTitle: string | null;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canRead = useAtomValue(notesRpc.read.permissionAtom(props.environmentId));
  if (primaryEnvironmentId !== props.environmentId || !canRead) return null;
  return <ThreadNotes {...props} />;
}

function ThreadNotes(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectTitle: string | null;
}) {
  const list = useEnvironmentQuery(
    notesSubscription({ environmentId: props.environmentId, input: {} }),
  );
  const canWrite = useAtomValue(notesRpc.write.permissionAtom(props.environmentId));
  const canUpdate = useAtomValue(notesRpc.update.permissionAtom(props.environmentId));
  const update = useNoteCommand(notesRpc.update);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notes = list.data?.notes ?? [];
  const createNote = useCreateNote(props.environmentId, notes);
  const ref: NoteThreadRef = { threadId: props.threadId, host: null };
  const isThis = (link: NoteThreadRef) => link.threadId === props.threadId && link.host === null;
  const started = (note: NoteSummary) => note.threads.some(isThis);
  const related = (note: NoteSummary) => (note.related ?? []).some(isThis);
  const linked = notes.filter((note) => started(note) || related(note));
  const editable = canUpdate && supportsNoteUpdate(notes);
  const candidates = orderNotes(
    filterNotes(
      notes.filter((note) => !linked.includes(note)),
      query,
    ),
  );
  const suggestions = [...candidates.pinned, ...candidates.rest].slice(0, LINK_RESULTS);
  if (!list.data?.ready || (notes.length === 0 && !canWrite)) return null;
  const relate = async (path: string, change: "relate" | "unrelate") => {
    setError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: { path, [change]: ref },
    });
    if (!result.ok) setError(noteErrorMessage(result.error));
    return result.ok;
  };
  const createForThread = async () => {
    setError(null);
    const folder =
      props.projectTitle && isNoteFolder(props.projectTitle) ? props.projectTitle : null;
    const created = await createNote(folder);
    if (!created.ok) {
      setError(noteErrorMessage(created.error));
      return;
    }
    if (editable) await relate(created.value.path, "relate");
    setOpen(false);
    void navigate({ to: "/notes", search: { path: created.value.path } });
  };
  const label =
    linked.length === 0
      ? "Notes for this thread"
      : `Notes for this thread (${linked.length} linked)`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Toggle
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  pressed={open}
                  aria-label={label}
                  variant="ghost"
                  size="sm"
                />
              }
            />
          }
        >
          <FileTextIcon className="size-4" />
          {linked.length > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">{linked.length}</span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="md" align="end">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <PopoverTitle>Notes for this thread</PopoverTitle>
          {linked.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes linked to this thread yet.</p>
          ) : (
            <ul className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-px" aria-label="Linked notes">
              {linked.map((note) => (
                <li
                  key={note.path}
                  className="flex items-start gap-1 rounded-md hover:bg-accent/50"
                >
                  <Link
                    to="/notes"
                    search={{ path: note.path }}
                    onClick={() => setOpen(false)}
                    className="grid min-w-0 flex-1 gap-0.5 px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="truncate text-sm font-medium">{note.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {started(note) ? "Work started from this note" : note.preview || note.path}
                    </span>
                  </Link>
                  {editable && related(note) && (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      className="mt-1.5 me-1"
                      aria-label={`Unlink ${note.title}`}
                      onClick={() => void relate(note.path, "unrelate")}
                    >
                      <XIcon aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && notes.length > linked.length && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <Input
                size="sm"
                type="search"
                aria-label="Find a note to link"
                placeholder="Link a note…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ul
                className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-px"
                aria-label="Notes to link"
              >
                {suggestions.map((note) => (
                  <li key={note.path}>
                    <button
                      type="button"
                      onClick={() => void relate(note.path, "relate")}
                      className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {note.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => void createForThread()}>
              <PlusIcon aria-hidden />
              New note for this thread
            </Button>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
