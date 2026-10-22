import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, NoteDocument, NoteSummary, NoteStatus } from "@goat/contracts";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { useStableCallback } from "../hooks/useStableCallback";
import { useEnvironmentQuery } from "../state/query";
import { notesQueries, notesRpc } from "../rpc/notes/atoms";
import { useFleetEnvironments } from "./useFleetEnvironments";
import { NoteChoice } from "./NoteControls";
import { NoteEditor } from "./NoteEditor";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { NoteFileDialog } from "./NoteFileDialog";
import { NoteLinkedThread } from "./NoteLinkedThread";
import { NoteStartWorkDialog } from "./NoteStartWorkDialog";
import { isNoteDirty, NoteSession } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

export function NoteLoader(props: {
  environmentId: EnvironmentId;
  path: string;
  summary: NoteSummary | undefined;
  removed: boolean;
  onSelect: (path: string | undefined) => void;
}) {
  const query = useEnvironmentQuery(
    notesQueries.read({ environmentId: props.environmentId, input: { path: props.path } }),
  );
  const document = query.data;
  const error = query.error;
  return (
    <>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground">
          {error}
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Reload
          </Button>
        </div>
      )}
      {document ? (
        <NoteDetail {...props} document={document} />
      ) : !error ? (
        <p role="status">Loading note…</p>
      ) : null}
    </>
  );
}

function NoteDetail(props: {
  environmentId: EnvironmentId;
  document: NoteDocument;
  summary: NoteSummary | undefined;
  removed: boolean;
  onSelect: (path: string | undefined) => void;
}) {
  const write = useNoteCommand(notesRpc.write);
  const read = useNoteCommand(notesRpc.read);
  const readCurrent = useStableCallback((path: string) =>
    read({ environmentId: props.environmentId, input: { path } }),
  );
  const writeCurrent = useStableCallback((input: Parameters<typeof write>[0]["input"]) =>
    write({ environmentId: props.environmentId, input }),
  );
  const [session] = useState(() => new NoteSession(props.document, writeCurrent));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const canWrite = useAtomValue(notesRpc.write.permissionAtom(props.environmentId));
  const canMove = useAtomValue(notesRpc.move.permissionAtom(props.environmentId));
  const canDelete = useAtomValue(notesRpc.delete.permissionAtom(props.environmentId));
  const canStart = useAtomValue(notesRpc.startWork.permissionAtom(props.environmentId));
  const [compare, setCompare] = useState(false);
  const [fileAction, setFileAction] = useState<"move" | "delete" | null>(null);
  const [start, setStart] = useState(false);
  const environments = useFleetEnvironments();
  const dirty = isNoteDirty(state);
  useEffect(() => {
    session.receive(props.document);
  }, [session, props.document]);
  const summary = props.summary;
  useEffect(() => {
    if (summary && summary.revision !== session.getSnapshot().document.revision)
      void session.refresh(() => readCurrent(summary.path));
  }, [session, summary, readCurrent]);
  useEffect(() => {
    if (
      !canWrite ||
      props.removed ||
      !dirty ||
      state.incoming ||
      state.saving ||
      state.error ||
      state.refreshing ||
      state.refreshError
    )
      return;
    const timeout = setTimeout(() => {
      void session.save({ body: state.body, status: state.status });
    }, 600);
    return () => clearTimeout(timeout);
  }, [
    session,
    state.body,
    state.status,
    state.incoming,
    state.saving,
    state.error,
    state.refreshing,
    state.refreshError,
    canWrite,
    dirty,
    props.removed,
  ]);
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      (current.pathname !== next.pathname ||
        ("path" in current.search ? current.search.path : undefined) !==
          ("path" in next.search ? next.search.path : undefined)) &&
      (dirty || state.saving) &&
      !window.confirm(
        state.saving
          ? "A note is still saving. Leave this page?"
          : "Discard unsaved changes to this note?",
      ),
    enableBeforeUnload: dirty || state.saving,
  });
  const latest = props.summary ?? state.document;
  return (
    <article className="min-w-0 space-y-4" aria-label="Selected note">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold">{latest.title || latest.path}</h2>
          <p className="break-all text-xs text-muted-foreground">{state.document.path}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canMove || dirty || state.saving || !!state.incoming || props.removed}
            onClick={() => setFileAction("move")}
          >
            Rename / move
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canDelete || dirty || state.saving || !!state.incoming || props.removed}
            onClick={() => setFileAction("delete")}
          >
            Delete
          </Button>
          <Button
            size="sm"
            disabled={!canStart || dirty || state.saving || !!state.incoming || props.removed}
            onClick={() => setStart(true)}
          >
            Start work
          </Button>
        </div>
      </div>
      {props.removed && (
        <p role="alert" className="text-sm text-destructive-foreground">
          This note was removed. Your draft is still visible; copy it before leaving.
        </p>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">This connection has read-only access.</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <NoteChoice
            label="Status"
            value={state.status}
            options={[
              { value: "idea", label: "Idea" },
              { value: "doing", label: "Doing" },
              { value: "done", label: "Done" },
            ]}
            disabled={!canWrite || props.removed}
            onChange={(value) => session.edit(state.body, value as NoteStatus)}
          />
        </div>
        <p className="pb-1 text-xs text-muted-foreground" role="status">
          {state.saving
            ? "Saving…"
            : state.incoming
              ? "Changed on disk"
              : state.error
                ? "Not saved"
                : dirty
                  ? "Unsaved changes"
                  : "Saved"}
        </p>
        {dirty && !state.incoming && (
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || state.saving || props.removed}
            onClick={() => void session.save()}
          >
            {state.error ? "Retry save" : "Save now"}
          </Button>
        )}
      </div>
      {state.refreshError && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground">
          {state.refreshError}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void session.refresh(() => readCurrent(state.document.path))}
          >
            Reload note
          </Button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {state.error}
        </p>
      )}
      {state.incoming && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"
        >
          <span>This note changed while you were editing. Compare before saving.</span>
          <Button size="sm" variant="outline" onClick={() => setCompare(true)}>
            Compare changes
          </Button>
        </div>
      )}
      <NoteEditor
        key={state.editorVersion}
        body={state.body}
        editable={canWrite && !props.removed}
        onChange={(body) => session.edit(body)}
      />
      <section aria-label="Linked threads" className="space-y-2">
        <h3 className="text-sm font-medium">Linked threads</h3>
        {latest.threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No work started from this note yet.</p>
        ) : (
          <ul className="space-y-2">
            {latest.threads.map((thread) => {
              const destination =
                thread.host === null
                  ? props.environmentId
                  : environments.find(
                      (environment) =>
                        environment.sshAliases.includes(thread.host!) ||
                        environment.label === thread.host,
                    )?.environmentId;
              return (
                <NoteLinkedThread
                  key={`${thread.host ?? "hub"}:${thread.threadId}`}
                  thread={thread}
                  destination={destination}
                />
              );
            })}
          </ul>
        )}
      </section>
      <NoteConflictDialog
        state={state}
        open={compare}
        canWrite={canWrite && !props.removed}
        onOpenChange={setCompare}
        onTheirs={() => {
          session.acceptTheirs();
          setCompare(false);
        }}
        onMine={() => {
          setCompare(false);
          void session.keepMine();
        }}
      />
      {fileAction && (
        <NoteFileDialog
          environmentId={props.environmentId}
          action={fileAction}
          document={state.document}
          onConflict={(current) => {
            session.compare(current);
            setFileAction(null);
            setCompare(true);
          }}
          onClose={() => setFileAction(null)}
          onDone={(path) => {
            setFileAction(null);
            props.onSelect(path);
          }}
        />
      )}
      {start && (
        <NoteStartWorkDialog
          environmentId={props.environmentId}
          path={state.document.path}
          onClose={() => setStart(false)}
        />
      )}
    </article>
  );
}
