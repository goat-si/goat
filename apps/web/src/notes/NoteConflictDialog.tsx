import { useMemo } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import type { NoteEditState } from "./noteState";
import { compareNoteLines } from "./noteState";

export function NoteConflictDialog(props: {
  state: NoteEditState;
  open: boolean;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onTheirs: () => void;
  onMine: () => void;
}) {
  const incoming = props.state.incoming;
  const open = props.open && incoming !== null;
  const theirs = incoming?.body ?? "";
  const mine = props.state.body;
  // oxlint-disable-next-line goat/no-manual-memo -- Expensive conflict comparisons require an explicit two-body cache independent of compiler inference.
  const comparison = useMemo(
    () =>
      open
        ? compareNoteLines(theirs, mine)
            .map(
              (line) =>
                `${line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}${line.text}`,
            )
            .join("\n")
        : "",
    [open, theirs, mine],
  );
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>This note changed</DialogTitle>
          <DialogDescription>
            Compare the current file with your draft. Keep mine saves against the current revision;
            a further change will ask again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm">
            On disk: {incoming?.status} · Your draft: {props.state.status}
          </p>
          <p className="text-xs text-muted-foreground">− On disk · + Your draft</p>
          <pre
            aria-label="Note changes"
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs"
          >
            {comparison}
          </pre>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={props.state.saving} onClick={props.onTheirs}>
            Use theirs
          </Button>
          <Button disabled={!props.canWrite || props.state.saving} onClick={props.onMine}>
            Keep mine
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
