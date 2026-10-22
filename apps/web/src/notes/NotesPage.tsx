import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { NotePath, type EnvironmentId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Input } from "../components/ui/input";
import { useContext, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { notesRpc, notesSubscription, retryFailedNoteRead } from "../rpc/notes/atoms";
import { NoteFileDialog } from "./NoteFileDialog";
import { NoteLoader } from "./NoteDetail";

const isNotePath = Schema.is(NotePath);

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

function EnvironmentNotes(props: {
  environmentId: EnvironmentId;
  path?: string;
  create?: boolean;
}) {
  const list = useEnvironmentQuery(
    notesSubscription({ environmentId: props.environmentId, input: {} }),
  );
  const canCreate = useAtomValue(notesRpc.write.permissionAtom(props.environmentId));
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const [creating, setCreating] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const notes = list.data?.notes ?? [];
  const folders = [...new Set(notes.map((note) => note.folder ?? ""))].sort();
  const select = (path: string | undefined) => {
    if (path && path === props.path) retryFailedNoteRead(registry, props.environmentId, path);
    void navigate({ to: "/notes", search: path ? { path } : {} });
  };
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-7xl gap-6 p-4 md:grid-cols-[16rem_minmax(0,1fr)] md:p-6">
        <nav aria-label="Notes" className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">Your notes</h2>
            <Button size="sm" disabled={!canCreate} onClick={() => setCreating(true)}>
              New note
            </Button>
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const path = openPath.normalize("NFC");
              if (isNotePath(path)) {
                setPathError(null);
                select(path);
              } else setPathError("Use note.md or folder/note.md.");
            }}
          >
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              Open by path
              <Input
                value={openPath}
                placeholder="folder/note.md"
                onChange={(event) => setOpenPath(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={!openPath}>
              Open note
            </Button>
            {pathError && (
              <p role="alert" className="text-xs text-destructive-foreground">
                {pathError}
              </p>
            )}
          </form>
          {list.error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {list.error}
              <Button size="sm" variant="outline" onClick={list.refresh}>
                Reconnect
              </Button>
            </p>
          )}
          {!list.data?.ready && !list.error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading notes…
            </p>
          )}
          {list.data?.ready && notes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No notes yet. Create a note to capture an idea.
            </p>
          )}
          {list.data?.truncated && (
            <p role="status" className="text-sm text-muted-foreground">
              This list is truncated. Open a note by its path to access other files.
            </p>
          )}
          {folders.map((folder) => (
            <section key={folder} className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{folder || "Unfiled"}</h3>
              <ul>
                {notes
                  .filter((note) => (note.folder ?? "") === folder)
                  .map((note) => (
                    <li key={note.path}>
                      <button
                        type="button"
                        aria-current={note.path === props.path ? "page" : undefined}
                        onClick={() => select(note.path)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent"
                      >
                        <span className="min-w-0 truncate">{note.title}</span>
                        <Badge
                          size="sm"
                          variant={
                            note.status === "done"
                              ? "success"
                              : note.status === "doing"
                                ? "info"
                                : "secondary"
                          }
                        >
                          {note.status}
                        </Badge>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>
        <main className="min-w-0">
          {props.path ? (
            <NoteLoader
              key={props.path}
              environmentId={props.environmentId}
              path={props.path}
              summary={notes.find((note) => note.path === props.path)}
              removed={list.data?.removedPaths.has(props.path) ?? false}
              onSelect={select}
            />
          ) : (
            <p className="py-8 text-sm text-muted-foreground">Select a note to read or edit it.</p>
          )}
        </main>
      </div>
      {(creating || props.create) && (
        <NoteFileDialog
          environmentId={props.environmentId}
          action="create"
          onClose={() => {
            setCreating(false);
            select(props.path);
          }}
          onDone={(path) => {
            setCreating(false);
            select(path);
          }}
        />
      )}
    </div>
  );
}
