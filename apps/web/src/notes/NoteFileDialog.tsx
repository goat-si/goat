import { useAtomValue } from "@effect/atom-react";
import {
  NoteConflictError,
  NotePath,
  type EnvironmentId,
  type NoteDocument,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import { notesRpc } from "../rpc/notes/atoms";
import { noteErrorMessage } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

const isNotePath = Schema.is(NotePath);
const isConflict = Schema.is(NoteConflictError);

export function NoteFileDialog(props: {
  environmentId: EnvironmentId;
  action: "move" | "delete";
  document: NoteDocument;
  onClose: () => void;
  onConflict?: (current: NoteDocument) => void;
  onDone: (path: string | undefined) => void;
}) {
  const [path, setPath] = useState(props.document.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = useNoteCommand(notesRpc.move);
  const remove = useNoteCommand(notesRpc.delete);
  const command = props.action === "move" ? notesRpc.move : notesRpc.delete;
  const allowed = useAtomValue(command.permissionAtom(props.environmentId));
  const title = props.action === "move" ? "Rename or move note" : "Delete note";
  async function submit() {
    if (busy || !allowed) return;
    const to = path.normalize("NFC");
    if (props.action === "move" && !isNotePath(to)) {
      setError(
        "Use name.md or folder/name.md. Notes go at most one folder deep, and names cannot start with a dot.",
      );
      return;
    }
    setBusy(true);
    const document = props.document;
    const result =
      props.action === "move"
        ? await move({
            environmentId: props.environmentId,
            input: { from: document.path, to, baseRevision: document.revision },
          })
        : await remove({
            environmentId: props.environmentId,
            input: { path: document.path, baseRevision: document.revision },
          });
    setBusy(false);
    if (!result.ok && isConflict(result.error) && props.onConflict) {
      props.onConflict(result.error.current);
      return;
    }
    if (result.ok) props.onDone(props.action === "delete" ? undefined : to);
    else setError(noteErrorMessage(result.error));
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {props.action === "delete"
              ? `Delete “${props.document.title}”? This removes ${props.document.path} from Notes.`
              : "The file name, optionally inside one folder. The title comes from the note’s first line."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.action === "move" && (
            <label className="grid gap-1.5 text-sm">
              File
              <Input
                autoFocus
                placeholder="project/idea.md"
                value={path}
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={props.action === "delete" ? "destructive" : "default"}
            disabled={
              !allowed || busy || (props.action === "move" && path === props.document?.path)
            }
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : title}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
