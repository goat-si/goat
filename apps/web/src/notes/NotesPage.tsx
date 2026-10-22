import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon } from "~/components/solar";
import { useContext, useEffect, useState } from "react";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Kbd } from "../components/ui/kbd";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useStableCallback } from "../hooks/useStableCallback";
import { matchesPageCommand, pageCommandShortcutLabel } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { notesRpc, notesSubscription, retryFailedNoteRead } from "../rpc/notes/atoms";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { NoteLoader } from "./NoteDetail";
import { NoteList } from "./NoteList";
import { markNotesPageOpen } from "./notesPageVisibility";
import { noteErrorMessage } from "./noteState";
import { useCreateNote } from "./useCreateNote";

export function NotesPage(props: { path?: string; create?: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron}>
          <h1>Notes</h1>
        </WorkspacePageHeader>
        {environmentId ? (
          <EnvironmentNotes key={environmentId} {...props} environmentId={environmentId} />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Connect to your hub to open notes.</p>
        )}
      </div>
    </SidebarInset>
  );
}

function focusNoteEditor() {
  document.querySelector<HTMLElement>("[data-note-editor] [contenteditable=true]")?.focus();
}

function EnvironmentNotes(props: {
  environmentId: EnvironmentId;
  path?: string;
  create?: boolean;
}) {
  const list = useEnvironmentQuery(
    notesSubscription({ environmentId: props.environmentId, input: {} }),
  );
  const canCreate = useAtomValue(notesRpc.write.permissionAtom(props.environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const [query, setQuery] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const notes = list.data?.notes ?? [];
  const ready = list.data?.ready === true;
  const createNote = useCreateNote(props.environmentId, notes);
  const select = (path: string | undefined, options?: { replace?: boolean }) => {
    if (path && path === props.path) retryFailedNoteRead(registry, props.environmentId, path);
    void navigate({
      to: "/notes",
      search: path ? { path } : {},
      replace: options?.replace === true,
    });
  };
  const create = useStableCallback(() => {
    if (!canCreate) return;
    setCreateError(null);
    void createNote().then((result) => {
      if (result.ok) {
        setCreatedPath(result.value.path);
        void navigate({
          to: "/notes",
          search: { path: result.value.path },
          replace: props.create === true,
        });
      } else {
        setCreateError(noteErrorMessage(result.error));
        if (props.create) void navigate({ to: "/notes", search: {}, replace: true });
      }
    });
  });
  // The palette and other surfaces ask for a note through ?create; wait for the list so the
  // Untitled name is picked against what exists.
  useEffect(() => {
    if (!props.create || !ready) return;
    if (canCreate) create();
    else void navigate({ to: "/notes", search: {}, replace: true });
  }, [props.create, ready, canCreate, create, navigate]);
  useEffect(() => markNotesPageOpen(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      if (
        matchesPageCommand(event, keybindings, "notes.new", {
          context: {
            terminalFocus: isTerminalFocused(),
            editableFocus: isEditableFocused(event.target),
          },
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        create();
      } else if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditableFocused(event.target)
      ) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-notes-search]")?.focus();
      }
    };
    // Capture runs before the app-wide new-thread handler, which shares mod+n by default.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, create]);
  const createShortcut = pageCommandShortcutLabel(keybindings, "notes.new", {
    context: { notesPageOpen: true },
  });
  const focusSelectedRow = () => {
    if (!props.path) return;
    document.querySelector<HTMLElement>(`[data-note-row="${CSS.escape(props.path)}"]`)?.focus();
  };
  const empty = ready && notes.length === 0;
  const emptyState = (
    <NotesEmpty
      kind={empty ? "none" : "unselected"}
      canCreate={canCreate}
      shortcut={createShortcut}
      onCreate={create}
    />
  );
  return (
    <div className="flex min-h-0 flex-1">
      <NoteList
        notes={notes}
        selectedPath={props.path}
        query={query}
        onQueryChange={setQuery}
        onSelect={select}
        onOpenEditor={() => requestAnimationFrame(focusNoteEditor)}
        onCreate={canCreate ? create : null}
        createShortcut={createShortcut}
        className={
          props.path
            ? "w-full shrink-0 max-md:hidden md:w-80 md:border-e"
            : "w-full shrink-0 md:w-80 md:border-e"
        }
      >
        {list.error && (
          <div role="alert" className="grid gap-2 px-3 py-2 text-sm text-destructive-foreground">
            {list.error}
            <Button size="sm" variant="outline" onClick={list.refresh}>
              Reconnect
            </Button>
          </div>
        )}
        {!ready && !list.error && (
          <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
            Loading notes…
          </p>
        )}
        {createError && (
          <div role="alert" className="grid gap-2 px-3 py-2 text-sm text-destructive-foreground">
            Couldn’t create a note. {createError}
            <Button size="sm" variant="outline" onClick={create}>
              Try again
            </Button>
          </div>
        )}
        {empty && <div className="md:hidden">{emptyState}</div>}
        {list.data?.truncated && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Showing the notes that fit in one list. Type a path such as folder/note.md to open
            another.
          </p>
        )}
      </NoteList>
      <main
        className={
          props.path
            ? "flex min-w-0 flex-1 flex-col overflow-y-auto"
            : "flex min-w-0 flex-1 flex-col overflow-y-auto max-md:hidden"
        }
      >
        {props.path ? (
          <NoteLoader
            key={props.path}
            environmentId={props.environmentId}
            path={props.path}
            summary={notes.find((note) => note.path === props.path)}
            removed={list.data?.removedPaths.has(props.path) ?? false}
            supportsUpdate={notes.some((note) => note.pinned !== undefined)}
            autoFocus={props.path === createdPath}
            onSelect={select}
            onExitEditor={focusSelectedRow}
          />
        ) : ready ? (
          emptyState
        ) : null}
      </main>
    </div>
  );
}

function NotesEmpty(props: {
  kind: "none" | "unselected";
  canCreate: boolean;
  shortcut: string | null;
  onCreate: () => void;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileTextIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{props.kind === "none" ? "No notes yet" : "No note open"}</EmptyTitle>
        <EmptyDescription>
          {props.kind === "none"
            ? "Capture plans, checklists, and context. You and your agents can both read and edit them."
            : "Pick a note from the list, or start a new one."}
        </EmptyDescription>
      </EmptyHeader>
      {props.canCreate && (
        <EmptyContent>
          <Button onClick={props.onCreate}>
            New note
            {props.shortcut ? <Kbd className="ms-1">{props.shortcut}</Kbd> : null}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
