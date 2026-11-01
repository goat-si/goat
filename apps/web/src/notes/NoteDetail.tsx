import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  NoteDocument,
  NoteStatus,
  NoteSummary,
  NoteThreadLink,
} from "@goat/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  EllipsisIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
} from "~/components/solar";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { notesQueries, notesRpc } from "../rpc/notes/atoms";
import { useFleetEnvironments } from "./useFleetEnvironments";
import { NoteChoice } from "./NoteControls";
import { NoteEditor } from "./NoteEditor";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { NoteFileDialog } from "./NoteFileDialog";
import { NoteLinkedThread } from "./NoteLinkedThread";
import { NoteStartWorkDialog } from "./NoteStartWorkDialog";
import { isNoteDirty, noteErrorMessage, NoteSession, type NoteEditState } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

interface NotePaneProps {
  environmentId: EnvironmentId;
  summary: NoteSummary | undefined;
  removed: boolean;
  /** False against an older hub that cannot pin or link. */
  supportsUpdate: boolean;
  autoFocus: boolean;
  onSelect: (path: string | undefined) => void;
  onExitEditor: () => void;
}

export function NoteLoader(props: NotePaneProps & { path: string }) {
  const query = useEnvironmentQuery(
    notesQueries.read({ environmentId: props.environmentId, input: { path: props.path } }),
  );
  const document = query.data;
  const error = query.error;
  return (
    <>
      {!document && <BackToNotes className="mx-4 mt-3" />}
      {error && (
        <div
          role="alert"
          className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-4 text-sm text-destructive-foreground md:px-8"
        >
          {error}
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Reload
          </Button>
        </div>
      )}
      {document ? (
        <NoteDetail {...props} document={document} />
      ) : !error ? (
        <p
          role="status"
          className="mx-auto w-full max-w-3xl px-4 py-6 text-sm text-muted-foreground md:px-8"
        >
          Loading note…
        </p>
      ) : null}
    </>
  );
}

function NoteDetail(props: NotePaneProps & { document: NoteDocument }) {
  const write = useNoteCommand(notesRpc.write);
  const read = useNoteCommand(notesRpc.read);
  const update = useNoteCommand(notesRpc.update);
  const readCurrent = useStableCallback((path: string) =>
    read({ environmentId: props.environmentId, input: { path } }),
  );
  const writeCurrent = useStableCallback((input: Parameters<typeof write>[0]["input"]) =>
    write({ environmentId: props.environmentId, input }),
  );
  // NoteLoader keys this pane by path, so a session never outlives its path.
  const [session] = useState(
    () => new NoteSession(props.document, writeCurrent, () => readCurrent(props.document.path)),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const canWrite = useAtomValue(notesRpc.write.permissionAtom(props.environmentId));
  const canMove = useAtomValue(notesRpc.move.permissionAtom(props.environmentId));
  const canDelete = useAtomValue(notesRpc.delete.permissionAtom(props.environmentId));
  const canStart = useAtomValue(notesRpc.startWork.permissionAtom(props.environmentId));
  const canUpdate =
    useAtomValue(notesRpc.update.permissionAtom(props.environmentId)) && props.supportsUpdate;
  const [compare, setCompare] = useState(false);
  const [fileAction, setFileAction] = useState<"move" | "delete" | null>(null);
  const [start, setStart] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const environments = useFleetEnvironments();
  // Focus only on the first mount; an editor remounted by a reload must not take focus back.
  const [focusOnMount] = useState(props.autoFocus);
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
  const pinned = latest.pinned === true;
  const fileBusy = dirty || state.saving || !!state.incoming || props.removed;
  const runUpdate = async (input: Omit<Parameters<typeof update>[0]["input"], "path">) => {
    setActionError(null);
    const result = await update({
      environmentId: props.environmentId,
      input: { path: state.document.path, ...input },
    });
    if (result.ok) session.receive(result.value);
    else setActionError(noteErrorMessage(result.error));
  };
  const destinationFor = (thread: Pick<NoteThreadLink, "host">) =>
    thread.host === null
      ? props.environmentId
      : environments.find(
          (environment) =>
            environment.sshAliases.includes(thread.host!) || environment.label === thread.host,
        )?.environmentId;
  const related = latest.related ?? [];
  const fileName = state.document.path.slice(state.document.path.lastIndexOf("/") + 1);
  return (
    <article className="flex min-w-0 flex-1 flex-col" aria-label="Selected note">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-1 md:px-8 md:pt-5">
        <BackToNotes />
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {state.document.folder ? <span>{state.document.folder} / </span> : null}
          {fileName}
        </p>
        <SaveState
          state={state}
          dirty={dirty}
          canWrite={canWrite}
          onRetry={() => void session.save()}
        />
        <div className="ms-auto flex items-center gap-1">
          <NoteChoice
            compact
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
          {canUpdate && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    size="sm"
                    variant="ghost"
                    aria-label="Pin note"
                    pressed={pinned}
                    disabled={props.removed}
                    onPressedChange={(next) => void runUpdate({ pinned: next })}
                  />
                }
              >
                {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{pinned ? "Unpin" : "Pin to the top"}</TooltipPopup>
            </Tooltip>
          )}
          {canStart && (
            <Button size="xs" variant="outline" disabled={fileBusy} onClick={() => setStart(true)}>
              <PlayIcon aria-hidden />
              Start work
            </Button>
          )}
          {(canMove || canDelete) && (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="More note actions" />}
              >
                <EllipsisIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem disabled={!canMove || fileBusy} onClick={() => setFileAction("move")}>
                  Rename or move…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={!canDelete || fileBusy}
                  onClick={() => setFileAction("delete")}
                >
                  Delete…
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-3xl gap-2 px-4 md:px-8">
        {props.removed && (
          <p role="alert" className="text-sm text-destructive-foreground">
            This note was removed. Your draft is still visible; copy it before leaving.
          </p>
        )}
        {!canWrite && (
          <p className="text-sm text-muted-foreground">This connection has read-only access.</p>
        )}
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
        {(state.error || actionError) && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {state.error ?? actionError}
          </p>
        )}
        {state.incoming && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/32 bg-warning/8 p-3 text-sm"
          >
            <span>This note changed while you were editing. Compare before saving.</span>
            <Button size="sm" variant="outline" onClick={() => setCompare(true)}>
              Compare changes
            </Button>
          </div>
        )}
      </div>
      <NoteEditor
        key={state.editorVersion}
        body={state.body}
        editable={canWrite && !props.removed}
        autoFocus={focusOnMount && state.editorVersion === 0}
        onChange={(body) => session.edit(body)}
        onExit={props.onExitEditor}
      />
      {(latest.threads.length > 0 || related.length > 0) && (
        <section
          aria-label="Linked threads"
          className="mx-auto w-full max-w-3xl px-4 pt-4 pb-10 md:px-8"
        >
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Threads</h2>
          <ul className="grid gap-px">
            {latest.threads.map((thread) => (
              <NoteLinkedThread
                key={`work:${thread.host ?? "hub"}:${thread.threadId}`}
                thread={thread}
                destination={destinationFor(thread)}
              />
            ))}
            {related.map((thread) => (
              <NoteLinkedThread
                key={`related:${thread.host ?? "hub"}:${thread.threadId}`}
                thread={{ ...thread, lastResult: null }}
                destination={destinationFor(thread)}
                related
                onUnlink={
                  canUpdate && !props.removed
                    ? () => void runUpdate({ unrelate: thread })
                    : undefined
                }
              />
            ))}
          </ul>
        </section>
      )}
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

/** The list and the note share the screen below md; this is the way back to the list there. */
function BackToNotes(props: { className?: string }) {
  const navigate = useNavigate();
  return (
    <div className={cn("md:hidden", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Back to notes"
        onClick={() => void navigate({ to: "/notes", search: {} })}
      >
        <ArrowLeftIcon aria-hidden />
      </Button>
    </div>
  );
}

function SaveState(props: {
  state: NoteEditState;
  dirty: boolean;
  canWrite: boolean;
  onRetry: () => void;
}) {
  const { state } = props;
  if (!props.canWrite) return null;
  const [label, tone] = state.saving
    ? ["Saving…", "text-muted-foreground"]
    : state.incoming
      ? ["Changed elsewhere", "text-warning-foreground"]
      : state.error
        ? ["Not saved", "text-destructive-foreground"]
        : props.dirty
          ? ["Unsaved", "text-muted-foreground"]
          : ["Saved", "text-muted-foreground"];
  return (
    <span role="status" className={cn("flex shrink-0 items-center gap-1 text-xs", tone)}>
      {label === "Saved" && <CheckIcon aria-hidden className="size-3" />}
      {label}
      {state.error && !state.incoming && (
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </span>
  );
}
